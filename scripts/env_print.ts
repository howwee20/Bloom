#!/usr/bin/env tsx
import "dotenv/config";
import { getConfig } from "../src/config.js";

const config = getConfig();

console.log(`env_type=${config.ENV_TYPE}`);
console.log(`base_chain=${config.BASE_CHAIN}`);
console.log(`db_path=${config.DB_PATH}`);
console.log(`card_mode=${config.CARD_MODE}`);
