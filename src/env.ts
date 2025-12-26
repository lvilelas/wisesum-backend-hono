export type Env = {
  /* App */
  PDF_TOKEN_SECRET: string;
  FRONTEND_URL: string;

  /* Supabase (backend) */
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;

  /* Clerk (backend auth) */
  CLERK_SECRET_KEY: string;
  CLERK_JWT_KEY: string;

  /* Stripe */
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE_MONTHLY?: string;
  STRIPE_PRICE_ONE_TIME?: string;

  /* Cloudflare (PDF) */
  CF_ACCOUNT_ID?: string;
  CF_BROWSER_RENDERING_API_TOKEN?: string;
};
