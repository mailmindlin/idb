import RequestPromise from './request-promise';

type IDBProxyable = IDBDatabase | IDBObjectStore | IDBIndex | IDBCursor | IDBTransaction;
type IDBCursorAdvanceMethod =
  IDBCursor['advance'] | IDBCursor['continue'] | IDBCursor['continuePrimaryKey'];

const idbProxyableTypes = [IDBDatabase, IDBObjectStore, IDBIndex, IDBCursor, IDBTransaction];
const cursorAdvanceMethods: IDBCursorAdvanceMethod[] = [
  IDBCursor.prototype.advance,
  IDBCursor.prototype.continue,
  IDBCursor.prototype.continuePrimaryKey,
];
const cursorRequestMap: WeakMap<IDBCursor, IDBRequest<IDBCursor>> = new WeakMap();
const transactionDoneMap: WeakMap<IDBTransaction, Promise<void>> = new WeakMap();
const transformCache = new WeakMap();
const reverseTransformCache = new WeakMap();

type Constructor = new (...args: any[]) => any;
type Func = (...args: any[]) => any;

function instanceOfAny(object: any, constructors: Constructor[]): boolean {
  for (const constructor of constructors) {
    if (object instanceof constructor) return true;
  }
  return false;
}

function promisifyRequest<T>(request: IDBRequest<T>): RequestPromise<T> {
  const promise = new RequestPromise(request, (resolve, reject) => {
    const unlisten = () => {
      request.removeEventListener('success', success);
      request.removeEventListener('error', error);
    };
    const success = () => {
      resolve(transformIdbValue(request.result));
      unlisten();
    };
    const error = () => {
      reject(request.error);
      unlisten();
    };
    request.addEventListener('success', success);
    request.addEventListener('error', error);
  });

  promise.then((value) => {
    // Remember the request for later
    if (value instanceof IDBCursor) {
      cursorRequestMap.set(value, request as unknown as IDBRequest<IDBCursor>);
    }
  });

  return promise as RequestPromise<T>;
}

function processTransaction(tx: IDBTransaction) {
  if (transactionDoneMap.has(tx)) return;
  const done = new Promise<void>((resolve, reject) => {
    const unlisten = () => {
      tx.removeEventListener('complete', complete);
      tx.removeEventListener('error', error);
      tx.removeEventListener('abort', error);
    };
    const complete = () => {
      resolve();
      unlisten();
    };
    const error = () => {
      reject(tx.error);
      unlisten();
    };
    tx.addEventListener('complete', complete);
    tx.addEventListener('error', error);
    tx.addEventListener('abort', error);
  });

  transactionDoneMap.set(tx, done);
}

const idbObjectHandler: ProxyHandler<any> = {
  get(target, prop) {
    if (prop === 'done' && target instanceof IDBTransaction) {
      return transactionDoneMap.get(target);
    }

    const value = target[prop];
    return transformIdbValue(value, target);
  },
};

function proxyIdbObject<T extends IDBProxyable>(target: T): T {
  return new Proxy(target, idbObjectHandler);
}

function wrapFunction<T extends Func>(func: T, parent: any): Function {
  // Cursor methods are special
  if (parent instanceof IDBCursor && cursorAdvanceMethods.includes(func)) {
    return function (this: IDBCursor, ...args: Parameters<T>) {
      // Calling the original function with the proxy as 'this' causes ILLEGAL INVOCATION, so we use
      // the original object.
      const originalCursor = reverseTransformCache.get(this);
      func.apply(originalCursor, args);
      const request = cursorRequestMap.get(this);
      return transformIdbValue(request);
    };
  }

  return function (this: typeof parent, ...args: Parameters<T>) {
    const originalParent = reverseTransformCache.get(this);
    const value = func.apply(originalParent, args);
    return transformIdbValue(value);
  };
}

function transformCachableValue(value: any, parent: any = null): any {
  if (typeof value === 'function') return wrapFunction(value, parent);

  if (value instanceof IDBTransaction) processTransaction(value); // Doesn't return
  if (instanceOfAny(value, idbProxyableTypes)) return proxyIdbObject(value);
  return value;
}

export default function transformIdbValue(value: any, parent: any = null): any {
  // We can generate multiple promises from a single IDBRequest (when cursoring), so these can't be
  // cached.
  if (value instanceof IDBRequest) return promisifyRequest(value);

  if (transformCache.has(value)) return transformCache.get(value);
  const newValue = transformCachableValue(value, parent);

  if (newValue !== value) {
    transformCache.set(value, newValue);
    reverseTransformCache.set(newValue, value);
  }

  return newValue;
}
