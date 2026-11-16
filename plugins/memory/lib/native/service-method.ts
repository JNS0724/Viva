/** Cordis reads methods through fresh tracing proxies. Compare own descriptors
 * when restoring a public adapter method, rather than comparing those proxies. */
export function replaceServiceMethod<T extends object, K extends keyof T>(service: T, key: K, value: T[K]) {
  const previous = Object.getOwnPropertyDescriptor(service, key)
  Object.defineProperty(service, key, { value, configurable: true, writable: true, enumerable: previous?.enumerable ?? false })
  return () => {
    if (Object.getOwnPropertyDescriptor(service, key)?.value !== value) return
    if (previous) Object.defineProperty(service, key, previous)
    else Reflect.deleteProperty(service, key)
  }
}
