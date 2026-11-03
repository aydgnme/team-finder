export interface Config {
  port: number;
  mongodbUri: string | undefined;
  mongodbDb: string;
  production: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 3000),
    mongodbUri: env.MONGODB_URI || undefined,
    mongodbDb: env.MONGODB_DB ?? 'team-finder',
    production: env.NODE_ENV === 'production',
  };
}
