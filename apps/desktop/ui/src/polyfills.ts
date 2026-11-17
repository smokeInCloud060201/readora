interface GlobalWithIterator {
  Iterator?: {
    prototype: {
      join?: (this: Iterable<unknown>, separator?: string) => string;
    };
  };
}

interface PromiseConstructorWithResolvers {
  withResolvers?: <T>() => {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  };
}

interface UrlConstructorWithParse {
  parse?: (url: string | URL, base?: string | URL) => URL | null;
}

const g = globalThis as unknown as GlobalWithIterator;

if (typeof g.Iterator === "undefined") {
  const iterInstance = [][Symbol.iterator]();
  const iterProto = Object.getPrototypeOf(
    Object.getPrototypeOf(iterInstance),
  ) as { join?: (this: Iterable<unknown>, separator?: string) => string };
  const IteratorCtor = function Iterator() {} as unknown as {
    prototype: { join?: (this: Iterable<unknown>, separator?: string) => string };
  };
  IteratorCtor.prototype = iterProto;
  g.Iterator = IteratorCtor;
}

if (g.Iterator?.prototype && typeof g.Iterator.prototype.join !== "function") {
  g.Iterator.prototype.join = function join(
    this: Iterable<unknown>,
    sep?: string,
  ): string {
    return Array.from(this).join(sep);
  };
}

const P = Promise as unknown as PromiseConstructorWithResolvers;
if (typeof P.withResolvers !== "function") {
  P.withResolvers = function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

const U = URL as unknown as UrlConstructorWithParse;
if (typeof U.parse !== "function") {
  U.parse = function parse(url: string | URL, base?: string | URL): URL | null {
    try {
      return new URL(url, base);
    } catch {
      return null;
    }
  };
}

export {};
