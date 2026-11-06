// Integration config: the database connection string comes from the environment.
export const dbConfig = {
  url: process.env.DATABASE_URL,
  poolSize: Number(process.env.DB_POOL_SIZE || 10),
};
