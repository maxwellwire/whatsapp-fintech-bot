import { env } from '../../config/env.js';

export const APP_NAME = env.APP_NAME;

export const MENU_TEXT = `🏦 Welcome to ${APP_NAME}

1️⃣ Check Balance
2️⃣ Buy Airtime
3️⃣ Buy Data
4️⃣ Transfer Money
5️⃣ Fund Wallet
6️⃣ Transaction History
7️⃣ Help

Reply with a number (1-7).
Type *menu* anytime. Type *cancel* to abort.`;

export const HELP_TEXT = `📖 *Help – ${APP_NAME}*

*1* Balance
*2* Airtime
*3* Data
*4* Bank transfer
*5* Fund wallet
*6* History
*7* Help

Type *menu* to return.`;

export const INVALID_OPTION = `❌ Invalid option. Reply *1–7* or type *menu*.`;