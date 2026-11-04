/**
 * "Load this section when it comes into view." `observeOnce` calls `onSeen` a single time, the first moment the element is
 * (nearly) visible, then stops watching. Without IntersectionObserver (old browser, tests) the section counts as seen at once, so
 * nothing stays empty.
 */

export interface ObserverLike {
  observe: (el: Element) => void;
  disconnect: () => void;
}
export type ObserverFactory = new (callback: (entries: readonly { isIntersecting: boolean }[]) => void, options?: { rootMargin?: string }) => ObserverLike;

export const DEFAULT_MARGIN = "200px";

export function observeOnce(el: Element, onSeen: () => void, rootMargin: string = DEFAULT_MARGIN, factory: ObserverFactory | undefined = (globalThis as { IntersectionObserver?: ObserverFactory }).IntersectionObserver): () => void {
  if (!factory) {
    onSeen();
    return () => undefined;
  }
  let done = false;
  const observer = new factory((entries) => {
    if (done || !entries.some((e) => e.isIntersecting)) return;
    done = true;
    observer.disconnect();
    onSeen();
  }, { rootMargin });
  observer.observe(el);
  return () => {
    done = true;
    observer.disconnect();
  };
}
