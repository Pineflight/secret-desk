import { vi } from "vitest";

/** Fake of `next/navigation`, mocked for every `*.test.tsx` by test/setup-dom.ts. Control it through `navigation`. */
export const router = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
};

let path = "/";
let search = new URLSearchParams();
let params: Record<string, string> = {};

export const navigation = {
  router,
  /** Sets what `usePathname()` returns; the optional query string sets `useSearchParams()`. */
  set(to: string): void {
    const [p = "/", q = ""] = to.split("?");
    path = p;
    search = new URLSearchParams(q);
  },
  /** Sets what `useParams()` returns (dynamic route segments such as `{ id: "x" }`). */
  setParams(next: Record<string, string>): void {
    params = next;
  },
};

export function resetNavigation(): void {
  path = "/";
  search = new URLSearchParams();
  params = {};
  for (const fn of Object.values(router)) fn.mockReset();
}

export const useRouter = () => router;
export const usePathname = () => path;
export const useSearchParams = () => search;
export const useParams = () => params;
