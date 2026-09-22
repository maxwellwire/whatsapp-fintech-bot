import { whatsappClient } from '../whatsapp/client.js';
import { sessionService } from './session.service.js';
import { MENU_TEXT, HELP_TEXT, INVALID_OPTION, APP_NAME } from '../shared/constants.js';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { AppError } from '../../middleware/errorHandler.js';
import { formatKobo, parseUserAmountToKobo } from '../../utils/money.js';
import { normalizePhoneNumber } from '../users/user.service.js';
import { fundingService } from '../payments/funding.service.js';
import { airtimeService } from '../airtime/airtime.service.js';
import { dataService } from '../data/data.service.js';
import { transferService, calculateTransferFeeKobo } from '../transfers/transfer.service.js';
import { historyService } from '../history/history.service.js';
import { pinService } from '../auth/pin.service.js';
import { POPULAR_BANKS } from '../transfers/providers/paystack.provider.js';
import type { UserWithWallet } from '../users/user.service.js';
import type { NetworkCode } from '../airtime/providers/types.js';
import type { DataPlan } from '../data/providers/types.js';

const NETWORK_MAP: Record<string, NetworkCode> = {
  '1': 'mtn',
  '2': 'airtel',
  '3': 'glo',
  '4': 'etisalat',
};
const NETWORK_LABELS: Record<NetworkCode, string> = {
  mtn: 'MTN',
  airtel: 'Airtel',
  glo: 'Glo',
  etisalat: '9mobile',
};

function displayPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  if (d.startsWith('234') && d.length === 13) return '0' + d.slice(3);
  return phone;
}

export class MenuHandler {
  async handleIncoming(user: UserWithWallet, phoneNumber: string, text: string): Promise<void> {
    const normalized = text.trim().toLowerCase();
    const session = await sessionService.get(phoneNumber);

    if (['hi', 'hello', 'hey', 'start', 'menu', '0'].includes(normalized)) {
      await whatsappClient.sendText(phoneNumber, MENU_TEXT);
      await sessionService.resetToMenu(user.id, phoneNumber);
      return;
    }
    if (normalized === 'cancel' || normalized === 'exit') {
      await sessionService.clear(phoneNumber);
      await whatsappClient.sendText(phoneNumber, '✅ Cancelled. Type *menu*.');
      return;
    }
    if (normalized === 'help' || normalized === '7') {
      await whatsappClient.sendText(phoneNumber, HELP_TEXT);
      await sessionService.resetToMenu(user.id, phoneNumber);
      return;
    }

    switch (session.state) {
      case 'SET_PIN':
        await this.handleSetPin(user, phoneNumber, text.trim());
        return;
      case 'FUND_AWAITING_AMOUNT':
        await this.handleFundAmount(user, phoneNumber, text.trim());
        return;
      case 'AIRTIME_AWAITING_NETWORK':
        await this.handleAirtimeNetwork(user, phoneNumber, normalized);
        return;
      case 'AIRTIME_AWAITING_PHONE':
        await this.handleAirtimePhone(user, phoneNumber, text.trim());
        return;
      case 'AIRTIME_AWAITING_AMOUNT':
        await this.handleAirtimeAmount(user, phoneNumber, text.trim());
        return;
      case 'AIRTIME_AWAITING_CONFIRM':
        await this.handleAirtimeConfirm(user, phoneNumber, normalized);
        return;
      case 'AIRTIME_AWAITING_PIN':
        await this.handleAirtimePin(user, phoneNumber, text.trim());
        return;
      case 'DATA_AWAITING_NETWORK':
        await this.handleDataNetwork(user, phoneNumber, normalized);
        return;
      case 'DATA_AWAITING_PHONE':
        await this.handleDataPhone(user, phoneNumber, text.trim());
        return;
      case 'DATA_AWAITING_PLAN':
        await this.handleDataPlan(user, phoneNumber, normalized);
        return;
      case 'DATA_AWAITING_CONFIRM':
        await this.handleDataConfirm(user, phoneNumber, normalized);
        return;
      case 'DATA_AWAITING_PIN':
        await this.handleDataPin(user, phoneNumber, text.trim());
        return;
      case 'TRANSFER_AWAITING_BANK':
        await this.handleTransferBank(user, phoneNumber, text.trim());
        return;
      case 'TRANSFER_AWAITING_ACCOUNT':
        await this.handleTransferAccount(user, phoneNumber, text.trim());
        return;
      case 'TRANSFER_AWAITING_AMOUNT':
        await this.handleTransferAmount(user, phoneNumber, text.trim());
        return;
      case 'TRANSFER_AWAITING_CONFIRM':
        await this.handleTransferConfirm(user, phoneNumber, normalized);
        return;
      case 'TRANSFER_AWAITING_PIN':
        await this.handleTransferPin(user, phoneNumber, text.trim());
        return;
      default:
        break;
    }

    await this.handleMenu(user, phoneNumber, normalized);
  }

  private async ensurePin(user: UserWithWallet, phoneNumber: string): Promise<boolean> {
    if (pinService.hasPin(user)) return true;
    await sessionService.set(user.id, phoneNumber, 'SET_PIN', {});
    await whatsappClient.sendText(
      phoneNumber,
      '🔐 Set a 4–6 digit transaction PIN before making payments.\n\nReply with your new PIN now.'
    );
    return false;
  }

  private async handleSetPin(user: UserWithWallet, phoneNumber: string, pin: string) {
    try {
      await pinService.setPin(user.id, pin);
      await sessionService.resetToMenu(user.id, phoneNumber);
      await whatsappClient.sendText(phoneNumber, '✅ PIN set successfully.\n\n' + MENU_TEXT);
    } catch (error) {
      const msg = error instanceof AppError ? error.message : 'Invalid PIN';
      await whatsappClient.sendText(phoneNumber, `❌ ${msg}`);
    }
  }

  private async handleMenu(user: UserWithWallet, phoneNumber: string, input: string) {
    switch (input) {
      case '1': {
        const bal = user.wallet?.balance ?? 0n;
        await whatsappClient.sendText(
          phoneNumber,
          `💰 *Wallet Balance*\n\nAvailable: *${formatKobo(bal)}*\n\nType *menu*.`
        );
        break;
      }
      case '2':
        await sessionService.set(user.id, phoneNumber, 'AIRTIME_AWAITING_NETWORK');
        await whatsappClient.sendText(
          phoneNumber,
          '📱 *Buy Airtime*\n\n1⃣ MTN\n2⃣ Airtel\n3⃣ Glo\n4⃣ 9mobile\n\nReply 1–4.'
        );
        break;
      case '3':
        await sessionService.set(user.id, phoneNumber, 'DATA_AWAITING_NETWORK');
        await whatsappClient.sendText(
          phoneNumber,
          '📶 *Buy Data*\n\n1⃣ MTN\n2⃣ Airtel\n3⃣ Glo\n4⃣ 9mobile\n\nReply 1–4.'
        );
        break;
      case '4': {
        const banks = POPULAR_BANKS.slice(0, 10);
        await sessionService.set(user.id, phoneNumber, 'TRANSFER_AWAITING_BANK', {
          displayedBanks: banks,
        });
        const lines = banks.map((b, i) => `${i + 1}️⃣ ${b.name}`);
        await whatsappClient.sendText(
          phoneNumber,
          `💸 *Transfer Money*\n\n${lines.join('\n')}\n\nOr send bank code (e.g. 058).`
        );
        break;
      }
      case '5':
        await sessionService.set(user.id, phoneNumber, 'FUND_AWAITING_AMOUNT');
        await whatsappClient.sendText(
          phoneNumber,
          `💳 *Fund Wallet*\n\nEnter amount in Naira.\nMin ${formatKobo(env.MIN_FUNDING_KOBO)}\nMax ${formatKobo(env.MAX_FUNDING_KOBO)}\n\nExample: *5000*`
        );
        break;
      case '6': {
        const text = await historyService.recentForUser(user.id);
        await whatsappClient.sendText(phoneNumber, text);
        break;
      }
      case '7':
        await whatsappClient.sendText(phoneNumber, HELP_TEXT);
        break;
      default:
        await whatsappClient.sendText(phoneNumber, INVALID_OPTION);
    }
  }

  private async handleFundAmount(user: UserWithWallet, phoneNumber: string, raw: string) {
    const kobo = parseUserAmountToKobo(raw);
    if (kobo === null) {
      await whatsappClient.sendText(phoneNumber, '❌ Enter a valid whole Naira amount, e.g. *5000*');
      return;
    }
    try {
      await whatsappClient.sendText(phoneNumber, '⏳ Creating payment link...');
      const { paymentLink, reference } = await fundingService.initiateFunding(user, kobo);
      await sessionService.resetToMenu(user.id, phoneNumber);
      await whatsappClient.sendText(
        phoneNumber,
        `✅ *Payment Link*\n\nAmount: *${formatKobo(kobo)}*\nRef: \`${reference}\`\n\n${paymentLink}\n\nYou will get a confirmation after payment.`
      );
    } catch (error) {
      await sessionService.resetToMenu(user.id, phoneNumber);
      const msg = error instanceof AppError ? error.message : 'Unable to start payment';
      await whatsappClient.sendText(phoneNumber, `❌ ${msg}`);
    }
  }

  private async handleAirtimeNetwork(user: UserWithWallet, phoneNumber: string, input: string) {
    const network = NETWORK_MAP[input];
    if (!network) {
      await whatsappClient.sendText(phoneNumber, '❌ Reply 1–4.');
      return;
    }
    await sessionService.set(user.id, phoneNumber, 'AIRTIME_AWAITING_PHONE', { network });
    await whatsappClient.sendText(
      phoneNumber,
      `Network: *${NETWORK_LABELS[network]}*\n\nEnter phone number (e.g. 08012345678).`
    );
  }

  private async handleAirtimePhone(user: UserWithWallet, phoneNumber: string, raw: string) {
    const digits = raw.replace(/\D/g, '');
    const valid =
      (digits.length === 11 && digits.startsWith('0')) ||
      (digits.length === 10 && /^[789]/.test(digits)) ||
      (digits.length === 13 && digits.startsWith('234'));
    if (!valid) {
      await whatsappClient.sendText(phoneNumber, '❌ Invalid Nigerian number.');
      return;
    }
    const recipient = normalizePhoneNumber(raw);
    await sessionService.setState(user.id, phoneNumber, 'AIRTIME_AWAITING_AMOUNT');
    await sessionService.updateContext(user.id, phoneNumber, { recipientPhone: recipient });
    await whatsappClient.sendText(
      phoneNumber,
      `Number: *${displayPhone(recipient)}*\n\nEnter amount in Naira.`
    );
  }

  private async handleAirtimeAmount(user: UserWithWallet, phoneNumber: string, raw: string) {
    const kobo = parseUserAmountToKobo(raw);
    if (kobo === null) {
      await whatsappClient.sendText(phoneNumber, '❌ Invalid amount.');
      return;
    }
    const session = await sessionService.get(phoneNumber);
    await sessionService.set(user.id, phoneNumber, 'AIRTIME_AWAITING_CONFIRM', {
      ...session.context,
      amountKobo: kobo.toString(),
    });
    await whatsappClient.sendText(
      phoneNumber,
      `📋 *Confirm Airtime*\n\nNetwork: *${NETWORK_LABELS[session.context.network as NetworkCode]}*\nNumber: *${displayPhone(String(session.context.recipientPhone))}*\nAmount: *${formatKobo(kobo)}*\n\n1⃣ Confirm\n2⃣ Cancel`
    );
  }

  private async handleAirtimeConfirm(user: UserWithWallet, phoneNumber: string, input: string) {
    if (input === '2' || input === 'cancel') {
      await sessionService.clear(phoneNumber);
      await whatsappClient.sendText(phoneNumber, '✅ Cancelled.');
      return;
    }
    if (input !== '1' && input !== 'confirm') {
      await whatsappClient.sendText(phoneNumber, 'Reply *1* or *2*.');
      return;
    }
    if (!(await this.ensurePin(user, phoneNumber))) return;
    await sessionService.setState(user.id, phoneNumber, 'AIRTIME_AWAITING_PIN');
    await whatsappClient.sendText(phoneNumber, '🔐 Enter your PIN to authorize.');
  }

  private async handleAirtimePin(user: UserWithWallet, phoneNumber: string, pin: string) {
    try {
      await pinService.verifyPin(user.id, pin);
    } catch (error) {
      const msg = error instanceof AppError ? error.message : 'Invalid PIN';
      await whatsappClient.sendText(phoneNumber, `❌ ${msg}`);
      return;
    }
    const session = await sessionService.get(phoneNumber);
    const network = session.context.network as NetworkCode;
    const recipientPhone = String(session.context.recipientPhone);
    const amountKobo = BigInt(String(session.context.amountKobo));
    await sessionService.resetToMenu(user.id, phoneNumber);
    await whatsappClient.sendText(phoneNumber, '⏳ Processing airtime...');
    try {
      await airtimeService.purchase({ user, network, phoneNumber: recipientPhone, amountKobo });
    } catch (error) {
      const msg = error instanceof AppError ? error.message : 'Failed';
      await whatsappClient.sendText(phoneNumber, `❌ ${msg}`);
    }
  }

  private async handleDataNetwork(user: UserWithWallet, phoneNumber: string, input: string) {
    const network = NETWORK_MAP[input];
    if (!network) {
      await whatsappClient.sendText(phoneNumber, '❌ Reply 1–4.');
      return;
    }
    await sessionService.set(user.id, phoneNumber, 'DATA_AWAITING_PHONE', { network });
    await whatsappClient.sendText(phoneNumber, `Network: *${NETWORK_LABELS[network]}*\n\nEnter phone number.`);
  }

  private async handleDataPhone(user: UserWithWallet, phoneNumber: string, raw: string) {
    const digits = raw.replace(/\D/g, '');
    const valid =
      (digits.length === 11 && digits.startsWith('0')) ||
      (digits.length === 10 && /^[789]/.test(digits)) ||
      (digits.length === 13 && digits.startsWith('234'));
    if (!valid) {
      await whatsappClient.sendText(phoneNumber, '❌ Invalid number.');
      return;
    }
    const recipient = normalizePhoneNumber(raw);
    const session = await sessionService.get(phoneNumber);
    const network = session.context.network as NetworkCode;
    await whatsappClient.sendText(phoneNumber, '⏳ Loading plans...');
    const plans = await dataService.listPlans(network);
    if (!plans.length) {
      await sessionService.resetToMenu(user.id, phoneNumber);
      await whatsappClient.sendText(phoneNumber, '❌ No plans available.');
      return;
    }
    // Serialize plans for session (bigint → string)
    const serializable = plans.map((p) => ({
      ...p,
      amountKobo: p.amountKobo.toString(),
    }));
    await sessionService.set(user.id, phoneNumber, 'DATA_AWAITING_PLAN', {
      network,
      recipientPhone: recipient,
      plans: serializable,
    });
    const lines = plans.map(
      (p, i) => `${i + 1}️⃣ ${p.planName} – ${formatKobo(p.amountKobo)}`
    );
    await whatsappClient.sendText(
      phoneNumber,
      `📶 *${NETWORK_LABELS[network]} Plans*\n\n${lines.join('\n')}\n\nReply with plan number.`
    );
  }

  private async handleDataPlan(user: UserWithWallet, phoneNumber: string, input: string) {
    const session = await sessionService.get(phoneNumber);
    const plans = session.context.plans as Array<DataPlan & { amountKobo: string }>;
    const idx = Number(input) - 1;
    if (!plans || !Number.isInteger(idx) || idx < 0 || idx >= plans.length) {
      await whatsappClient.sendText(phoneNumber, '❌ Invalid plan number.');
      return;
    }
    const plan = plans[idx];
    await sessionService.set(user.id, phoneNumber, 'DATA_AWAITING_CONFIRM', {
      network: session.context.network,
      recipientPhone: session.context.recipientPhone,
      plan,
    });
    await whatsappClient.sendText(
      phoneNumber,
      `📋 *Confirm Data*\n\nPlan: *${plan.planName}*\nAmount: *${formatKobo(BigInt(plan.amountKobo))}*\n\n1⃣ Confirm\n2⃣ Cancel`
    );
  }

  private async handleDataConfirm(user: UserWithWallet, phoneNumber: string, input: string) {
    if (input === '2' || input === 'cancel') {
      await sessionService.clear(phoneNumber);
      await whatsappClient.sendText(phoneNumber, '✅ Cancelled.');
      return;
    }
    if (input !== '1' && input !== 'confirm') {
      await whatsappClient.sendText(phoneNumber, 'Reply *1* or *2*.');
      return;
    }
    if (!(await this.ensurePin(user, phoneNumber))) return;
    await sessionService.setState(user.id, phoneNumber, 'DATA_AWAITING_PIN');
    await whatsappClient.sendText(phoneNumber, '🔐 Enter your PIN.');
  }

  private async handleDataPin(user: UserWithWallet, phoneNumber: string, pin: string) {
    try {
      await pinService.verifyPin(user.id, pin);
    } catch (error) {
      const msg = error instanceof AppError ? error.message : 'Invalid PIN';
      await whatsappClient.sendText(phoneNumber, `❌ ${msg}`);
      return;
    }
    const session = await sessionService.get(phoneNumber);
    const planRaw = session.context.plan as DataPlan & { amountKobo: string };
    const plan: DataPlan = {
      ...planRaw,
      amountKobo: BigInt(planRaw.amountKobo),
      network: session.context.network as NetworkCode,
    };
    await sessionService.resetToMenu(user.id, phoneNumber);
    await whatsappClient.sendText(phoneNumber, '⏳ Processing data...');
    try {
      await dataService.purchase({
        user,
        network: session.context.network as NetworkCode,
        phoneNumber: String(session.context.recipientPhone),
        plan,
      });
    } catch (error) {
      const msg = error instanceof AppError ? error.message : 'Failed';
      await whatsappClient.sendText(phoneNumber, `❌ ${msg}`);
    }
  }

  private async handleTransferBank(user: UserWithWallet, phoneNumber: string, input: string) {
    const session = await sessionService.get(phoneNumber);
    const displayed = (session.context.displayedBanks as Array<{ code: string; name: string }>) || [];
    let bankCode: string | undefined;
    let bankName: string | undefined;
    const idx = Number(input) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < displayed.length) {
      bankCode = displayed[idx].code;
      bankName = displayed[idx].name;
    } else {
      const code = input.replace(/\D/g, '');
      if (code.length >= 3) {
        const banks = await transferService.listBanks();
        const found = banks.find((b) => b.code === code);
        bankCode = found?.code || code;
        bankName = found?.name || `Bank ${code}`;
      }
    }
    if (!bankCode) {
      await whatsappClient.sendText(phoneNumber, '❌ Invalid bank.');
      return;
    }
    await sessionService.set(user.id, phoneNumber, 'TRANSFER_AWAITING_ACCOUNT', {
      bankCode,
      bankName,
    });
    await whatsappClient.sendText(
      phoneNumber,
      `Bank: *${bankName}*\n\nEnter 10-digit account number.`
    );
  }

  private async handleTransferAccount(user: UserWithWallet, phoneNumber: string, raw: string) {
    const accountNumber = raw.replace(/\D/g, '');
    if (accountNumber.length !== 10) {
      await whatsappClient.sendText(phoneNumber, '❌ Account must be 10 digits.');
      return;
    }
    const session = await sessionService.get(phoneNumber);
    const bankCode = String(session.context.bankCode);
    await whatsappClient.sendText(phoneNumber, '⏳ Verifying account...');
    try {
      const resolved = await transferService.resolveAccount(accountNumber, bankCode);
      if (!resolved) {
        await whatsappClient.sendText(phoneNumber, '❌ Could not verify account.');
        return;
      }
      await sessionService.set(user.id, phoneNumber, 'TRANSFER_AWAITING_AMOUNT', {
        bankCode,
        bankName: resolved.bankName || session.context.bankName,
        accountNumber: resolved.accountNumber,
        accountName: resolved.accountName,
      });
      await whatsappClient.sendText(
        phoneNumber,
        `✅ *Verified*\n\nRecipient: *${resolved.accountName}*\nBank: *${resolved.bankName || session.context.bankName}*\nAccount: *${resolved.accountNumber}*\n\nEnter amount in Naira.`
      );
    } catch (error) {
      const msg = error instanceof AppError ? error.message : 'Verify failed';
      await whatsappClient.sendText(phoneNumber, `❌ ${msg}`);
    }
  }

  private async handleTransferAmount(user: UserWithWallet, phoneNumber: string, raw: string) {
    const kobo = parseUserAmountToKobo(raw);
    if (kobo === null) {
      await whatsappClient.sendText(phoneNumber, '❌ Invalid amount.');
      return;
    }
    const fee = calculateTransferFeeKobo(kobo);
    const total = kobo + fee;
    const session = await sessionService.get(phoneNumber);
    await sessionService.set(user.id, phoneNumber, 'TRANSFER_AWAITING_CONFIRM', {
      ...session.context,
      amountKobo: kobo.toString(),
      feeKobo: fee.toString(),
    });
    await whatsappClient.sendText(
      phoneNumber,
      `💸 *Transfer Confirmation*\n\nRecipient: *${session.context.accountName}*\nBank: *${session.context.bankName}*\nAccount: *${session.context.accountNumber}*\nAmount: *${formatKobo(kobo)}*\nFee: *${formatKobo(fee)}*\nTotal: *${formatKobo(total)}*\n\n1⃣ Confirm\n2⃣ Cancel`
    );
  }

  private async handleTransferConfirm(user: UserWithWallet, phoneNumber: string, input: string) {
    if (input === '2' || input === 'cancel') {
      await sessionService.clear(phoneNumber);
      await whatsappClient.sendText(phoneNumber, '✅ Cancelled.');
      return;
    }
    if (input !== '1' && input !== 'confirm') {
      await whatsappClient.sendText(phoneNumber, 'Reply *1* or *2*.');
      return;
    }
    if (!(await this.ensurePin(user, phoneNumber))) return;
    await sessionService.setState(user.id, phoneNumber, 'TRANSFER_AWAITING_PIN');
    await whatsappClient.sendText(phoneNumber, '🔐 Enter your PIN to authorize transfer.');
  }

  private async handleTransferPin(user: UserWithWallet, phoneNumber: string, pin: string) {
    try {
      await pinService.verifyPin(user.id, pin);
    } catch (error) {
      const msg = error instanceof AppError ? error.message : 'Invalid PIN';
      await whatsappClient.sendText(phoneNumber, `❌ ${msg}`);
      return;
    }
    const session = await sessionService.get(phoneNumber);
    await sessionService.resetToMenu(user.id, phoneNumber);
    await whatsappClient.sendText(phoneNumber, '⏳ Processing transfer...');
    try {
      await transferService.transfer({
        user,
        accountNumber: String(session.context.accountNumber),
        accountName: String(session.context.accountName),
        bankCode: String(session.context.bankCode),
        bankName: String(session.context.bankName),
        amountKobo: BigInt(String(session.context.amountKobo)),
      });
    } catch (error) {
      const msg = error instanceof AppError ? error.message : 'Transfer failed';
      logger.error('Transfer error', error);
      await whatsappClient.sendText(phoneNumber, `❌ ${msg}`);
    }
  }
}

export const menuHandler = new MenuHandler();