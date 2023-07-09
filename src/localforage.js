import idbDriver from './drivers/indexeddb';
import websqlDriver from './drivers/websql';
import localstorageDriver from './drivers/localstorage';
import serializer from './utils/serializer';
import Promise from './utils/promise';
import executeCallback from './utils/executeCallback';
import executeTwoCallbacks from './utils/executeTwoCallbacks';
import includes from './utils/includes';
import isArray from './utils/isArray';

// Drivers are stored here when `defineDriver()` is called.
// They are shared across all instances of localForage.
const DefinedDrivers = {}; // 用来存储实例

const DriverSupport = {};

const DefaultDrivers = {
    INDEXEDDB: idbDriver,
    WEBSQL: websqlDriver,
    LOCALSTORAGE: localstorageDriver
};

const DefaultDriverOrder = [
    DefaultDrivers.INDEXEDDB._driver,
    DefaultDrivers.WEBSQL._driver,
    DefaultDrivers.LOCALSTORAGE._driver
];

const OptionalDriverMethods = ['dropInstance'];

const LibraryMethods = [
    'clear',
    'getItem',
    'iterate',
    'key',
    'keys',
    'length',
    'removeItem',
    'setItem'
].concat(OptionalDriverMethods);

const DefaultConfig = {
    description: '',
    driver: DefaultDriverOrder.slice(),
    name: 'localforage',
    // Default DB size is _JUST UNDER_ 5MB, as it's the highest size
    // we can use without a prompt.
    size: 4980736,
    storeName: 'keyvaluepairs',
    version: 1.0
};

function callWhenReady(localForageInstance, libraryMethod) {
    localForageInstance[libraryMethod] = function() {
        const _args = arguments;
        return localForageInstance.ready().then(function() {
            return localForageInstance[libraryMethod].apply(
                localForageInstance,
                _args
            );
        });
    };
}

function extend() {
    for (let i = 1; i < arguments.length; i++) {
        const arg = arguments[i];

        if (arg) {
            for (let key in arg) {
                if (arg.hasOwnProperty(key)) {
                    if (isArray(arg[key])) {
                        arguments[0][key] = arg[key].slice();
                    } else {
                        arguments[0][key] = arg[key];
                    }
                }
            }
        }
    }

    return arguments[0];
}

class LocalForage {
    constructor(options) {
        // DefaultDrivers: asyncStorage、webSQLStorage、localStorageWrapper
        for (let driverTypeKey in DefaultDrivers) {
            if (DefaultDrivers.hasOwnProperty(driverTypeKey)) {
                const driver = DefaultDrivers[driverTypeKey];
                const driverName = driver._driver;
                this[driverTypeKey] = driverName; // eg: localforage.INDEXEDDB就可获取到， 方便后续config配置

                // export首次实例化默认全部初始化，方便后续再次实例化引用
                if (!DefinedDrivers[driverName]) {
                    // we don't need to wait for the promise,
                    // since the default drivers can be defined
                    // in a blocking manner
                    this.defineDriver(driver);
                }
            }
        }

        this._defaultConfig = extend({}, DefaultConfig); // 初始化使用的默认配置
        this._config = extend({}, this._defaultConfig, options); // 初始化配置，或者用户设置的配置
        this._driverSet = null; // 设置当前需要使用的存储方式promise,方便后续执行callback
        this._initDriver = null;
        this._ready = false; // 存储初始化promise
        this._dbInfo = null;

        this._wrapLibraryMethodsWithReady(); // 遍历driver方法并改变this指向
        this.setDriver(this._config.driver).catch(() => {});
    }

    // Set any config values for localForage; can be called anytime before
    // the first API call (e.g. `getItem`, `setItem`).
    // We loop through options so we don't overwrite existing config
    // values.
    config(options) {
        // If the options argument is an object, we use it to set values.
        // Otherwise, we return either a specified config value or all
        // config values.
        if (typeof options === 'object') {
            // If localforage is ready and fully initialized, we can't set
            // any new configuration values. Instead, we return an error.
            if (this._ready) {
                return new Error(
                    "Can't call config() after localforage " + 'has been used.'
                );
            }

            for (let i in options) {
                if (i === 'storeName') {
                    options[i] = options[i].replace(/\W/g, '_');
                }

                if (i === 'version' && typeof options[i] !== 'number') {
                    return new Error('Database version must be a number.');
                }

                this._config[i] = options[i];
            }

            // after all config options are set and
            // the driver option is used, try setting it
            if ('driver' in options && options.driver) {
                return this.setDriver(this._config.driver);
            }

            return true;
        } else if (typeof options === 'string') {
            return this._config[options];
        } else {
            return this._config;
        }
    }

    // Used to define a custom driver, shared across all instances of
    // localForage.
    defineDriver(driverObject, callback, errorCallback) {
        const promise = new Promise(function(resolve, reject) {
            try {
                const driverName = driverObject._driver;
                const complianceError = new Error(
                    'Custom driver not compliant; see ' +
                        'https://mozilla.github.io/localForage/#definedriver'
                );

                // A driver name should be defined and not overlap with the
                // library-defined, default drivers.
                if (!driverObject._driver) {
                    reject(complianceError);
                    return;
                }

                const driverMethods = LibraryMethods.concat('_initStorage');
                for (let i = 0, len = driverMethods.length; i < len; i++) {
                    const driverMethodName = driverMethods[i];

                    // when the property is there,
                    // it should be a method even when optional
                    const isRequired = !includes(
                        OptionalDriverMethods,
                        driverMethodName
                    );
                    if (
                        (isRequired || driverObject[driverMethodName]) &&
                        typeof driverObject[driverMethodName] !== 'function'
                    ) {
                        reject(complianceError);
                        return;
                    }
                }

                const configureMissingMethods = function() {
                    const methodNotImplementedFactory = function(methodName) {
                        return function() {
                            const error = new Error(
                                `Method ${methodName} is not implemented by the current driver`
                            );
                            const promise = Promise.reject(error);
                            executeCallback(
                                promise,
                                arguments[arguments.length - 1]
                            );
                            return promise;
                        };
                    };

                    for (
                        let i = 0, len = OptionalDriverMethods.length;
                        i < len;
                        i++
                    ) {
                        const optionalDriverMethod = OptionalDriverMethods[i];
                        if (!driverObject[optionalDriverMethod]) {
                            driverObject[
                                optionalDriverMethod
                            ] = methodNotImplementedFactory(
                                optionalDriverMethod
                            );
                        }
                    }
                };

                configureMissingMethods();

                const setDriverSupport = function(support) {
                    if (DefinedDrivers[driverName]) {
                        console.info(
                            `Redefining LocalForage driver: ${driverName}`
                        );
                    }
                    DefinedDrivers[driverName] = driverObject;
                    DriverSupport[driverName] = support;
                    // don't use a then, so that we can define
                    // drivers that have simple _support methods
                    // in a blocking manner
                    resolve();
                };

                if ('_support' in driverObject) {
                    if (
                        driverObject._support &&
                        typeof driverObject._support === 'function'
                    ) {
                        driverObject._support().then(setDriverSupport, reject);
                    } else {
                        setDriverSupport(!!driverObject._support);
                    }
                } else {
                    setDriverSupport(true);
                }
            } catch (e) {
                reject(e);
            }
        });

        executeTwoCallbacks(promise, callback, errorCallback);
        return promise;
    }

    driver() {
        return this._driver || null;
    }

    getDriver(driverName, callback, errorCallback) {
        const getDriverPromise = DefinedDrivers[driverName]
            ? Promise.resolve(DefinedDrivers[driverName])
            : Promise.reject(new Error('Driver not found.'));

        executeTwoCallbacks(getDriverPromise, callback, errorCallback);
        return getDriverPromise;
    }

    getSerializer(callback) {
        const serializerPromise = Promise.resolve(serializer);
        executeTwoCallbacks(serializerPromise, callback);
        return serializerPromise;
    }

    ready(callback) {
        const self = this;

        const promise = self._driverSet.then(() => {
            if (self._ready === null) {
                self._ready = self._initDriver();
            }

            return self._ready;
        });

        executeTwoCallbacks(promise, callback, callback);
        return promise;
    }

    setDriver(drivers, callback, errorCallback) {
        const self = this;

        if (!isArray(drivers)) {
            drivers = [drivers];
        }

        const supportedDrivers = this._getSupportedDrivers(drivers);

        function setDriverToConfig() {
            self._config.driver = self.driver();
        }
        // 将driver属性赋值localforage, 初始化ready方法
        function extendSelfWithDriver(driver) {
            self._extend(driver);
            setDriverToConfig();

            self._ready = self._initStorage(self._config);
            return self._ready;
        }

        function initDriver(supportedDrivers) {
            return function() {
                let currentDriverIndex = 0;

                function driverPromiseLoop() {
                    while (currentDriverIndex < supportedDrivers.length) {
                        let driverName = supportedDrivers[currentDriverIndex];
                        currentDriverIndex++;

                        self._dbInfo = null;
                        self._ready = null;

                        return self
                            .getDriver(driverName) // 获取用户设置的driver
                            .then(extendSelfWithDriver) // 将driver属性方法赋值到localforage
                            .catch(driverPromiseLoop);
                    }

                    setDriverToConfig();
                    const error = new Error(
                        'No available storage method found.'
                    );
                    self._driverSet = Promise.reject(error);
                    return self._driverSet;
                }

                return driverPromiseLoop();
            };
        }

        // 可能正在进行驱动程序初始化，因此等待它完成以避免设置 _dbInfo 的可能竞争条件
        const oldDriverSetDone =
            this._driverSet !== null
                ? this._driverSet.catch(() => Promise.resolve())
                : Promise.resolve();

        this._driverSet = oldDriverSetDone
            .then(() => {
                const driverName = supportedDrivers[0];
                self._dbInfo = null;
                self._ready = null;

                return self.getDriver(driverName).then(driver => {
                    self._driver = driver._driver;
                    setDriverToConfig();
                    self._wrapLibraryMethodsWithReady();
                    self._initDriver = initDriver(supportedDrivers);
                });
            })
            .catch(() => {
                setDriverToConfig();
                const error = new Error('No available storage method found.');
                self._driverSet = Promise.reject(error);
                return self._driverSet;
            });

        executeTwoCallbacks(this._driverSet, callback, errorCallback);
        return this._driverSet;
    }

    supports(driverName) {
        return !!DriverSupport[driverName];
    }

    _extend(libraryMethodsAndProperties) {
        extend(this, libraryMethodsAndProperties);
    }

    _getSupportedDrivers(drivers) {
        const supportedDrivers = [];
        for (let i = 0, len = drivers.length; i < len; i++) {
            const driverName = drivers[i];
            if (this.supports(driverName)) {
                supportedDrivers.push(driverName);
            }
        }
        return supportedDrivers;
    }

    _wrapLibraryMethodsWithReady() {
        // 为每个驱动程序 API 方法添加一个存根，延迟对相应驱动程序方法的调用，直到 localForage 准备就绪。 一旦加载驱动程序，这些存根将被驱动程序方法替换，因此不会影响性能。
        for (let i = 0, len = LibraryMethods.length; i < len; i++) {
            callWhenReady(this, LibraryMethods[i]);
        }
    }

    createInstance(options) {
        return new LocalForage(options);
    }
}

// The actual localForage object that we expose as a module or via a
// global. It's extended by pulling in one of our other libraries.
export default new LocalForage();
