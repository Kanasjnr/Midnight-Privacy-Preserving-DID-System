import { WebSocket } from "ws";

/**
 * SDK Compatibility Polyfills
 * 
 * Provides essential runtime extensions for the Midnight SDK (0.15.x)
 * including iterator functional methods and WebSocket global injection.
 */

const polyfillIterator = (proto: any): void => {
  if (!proto) return;
  const methods = ['map', 'filter', 'every', 'some', 'find', 'reduce', 'forEach', 'toArray'];
  for (const method of methods) {
    if (!proto[method]) {
      proto[method] = function (this: any, ...args: any[]) {
        const arr = Array.from(this);
        if (method === 'toArray') return arr;
        return (arr[method as any] as any)(...args);
      };
    }
  }
};

/**
 * Initializes global polyfills for Map/Set/Array iterators and WebSockets.
 * Essential for Midnight SDK functional chaining compatibility.
 */
export const initializePolyfills = (): void => {
  polyfillIterator(Object.getPrototypeOf(new Map().values()));
  polyfillIterator(Object.getPrototypeOf(new Map().entries()));
  polyfillIterator(Object.getPrototypeOf(new Map().keys()));
  polyfillIterator(Object.getPrototypeOf(new Set().values()));
  polyfillIterator(Object.getPrototypeOf([].values()));

  if (!(Array.prototype as any).toArray) {
    Object.defineProperty(Array.prototype, 'toArray', {
      value: function () { return this; },
      enumerable: false,
      configurable: true
    });
  }

  // @ts-ignore
  globalThis.WebSocket = WebSocket;
};
