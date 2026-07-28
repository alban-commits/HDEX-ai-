type AppEnv = {
  HF_ENV?: string;
  APP_SLUG?: string;
  OPENAI_API_KEY?: string;
  DB?: {
    prepare(sql: string): {
      first<T>(): Promise<T | null>;
      bind(...values: unknown[]): {
        run(): Promise<unknown>;
      };
    };
  };
};

/**
 * Node/Windows service environment. Values are read per request and never bundled for the browser.
 * DB stays optional only so existing server functions remain source-compatible; Node does not bind D1.
 */
export function bindings(): AppEnv {
  return {
    HF_ENV: process.env.HF_ENV,
    APP_SLUG: process.env.APP_SLUG,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
}
