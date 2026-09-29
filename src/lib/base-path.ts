// next/link, router.push and redirect() add basePath themselves; plain fetch() and <img src> URLs need this prefix.
export const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
