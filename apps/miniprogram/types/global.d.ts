declare function App<T extends Record<string, unknown>>(options: T): void;

declare function Page<Data extends Record<string, unknown>>(options: {
  data: Data;
  [key: string]: unknown;
}): void;
