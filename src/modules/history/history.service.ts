import { prisma } from '../../infrastructure/database/prisma.js';
import { formatKobo } from '../../utils/money.js';

export class HistoryService {
  async recentForUser(userId: string, limit = 5): Promise<string> {
    const rows = await prisma.transaction.findMany({
      where: { userId, type: { not: 'FEE' } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    if (!rows.length) {
      return '📜 *Transaction History*\n\nNo transactions yet.\n\nType *menu*.';
    }

    const lines = rows.map((t, i) => {
      const amt = formatKobo(t.amount);
      const date = t.createdAt.toISOString().slice(0, 10);
      return `${i + 1}. ${t.type} · ${t.status} · ${amt} · ${date}`;
    });

    return `📜 *Recent Transactions*\n\n${lines.join('\n')}\n\nType *menu*.`;
  }
}

export const historyService = new HistoryService();