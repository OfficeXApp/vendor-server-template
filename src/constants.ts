export const LOCAL_DEV_MODE = process.env.NODE_ENV !== "production";
export const FREE_MODE = false;

export const vendor_server_endpoint =
  process.env.NODE_ENV === "production" && process.env.SERVER_DOMAIN
    ? `https://${process.env.SERVER_DOMAIN}`
    : "http://localhost:3001";
