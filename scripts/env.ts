/** Load env files like Next does for scripts: .env.local wins over .env. */
import { config } from "dotenv";
config({ path: [".env.local", ".env"], quiet: true });
