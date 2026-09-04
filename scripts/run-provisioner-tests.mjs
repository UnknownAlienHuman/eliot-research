process.env.ELIOTR_ACCESS_TEAM_DOMAIN ??= "https://mock-team.cloudflareaccess.com";
process.env.ELIOTR_ACCESS_AUDIENCE ??= "mock-access-audience";
process.env.ELIOTR_ACCESS_SERVICE_PRINCIPALS ??= "eliotr-federation,eliotr-agent";
await import("./test-cloudflare-provisioners.mjs");
await import("./test-ai-search-provisioning-readback.mjs");
