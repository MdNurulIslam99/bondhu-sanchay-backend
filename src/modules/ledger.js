// Loads the records that every balance, report and dashboard is calculated from.
import { accountSummary, fundTotals, memberDues, memberShare, sum } from '../domain/calculations.js';
import { InvestmentAccount, InvestmentEntry, Member, Payment, Profit, Project, Submission, Withdrawal } from '../models/index.js';
import { getSettings } from './settings.js';

export async function loadLedger() {
  const [settings, members, payments, accountRows, entries, profits, projects, submissions, withdrawals] = await Promise.all([
    getSettings(),
    Member.find().sort({ sl: 1 }).lean(),
    Payment.find({ status: 'verified' }).lean(),
    InvestmentAccount.find().sort({ createdAt: 1, _id: 1 }).lean(),
    InvestmentEntry.find().sort({ investDate: 1, _id: 1 }).lean(),
    Profit.find().lean(),
    Project.find().sort({ sortOrder: 1, startDate: 1, _id: 1 }).lean(),
    Submission.find({ status: { $in: ['pending', 'verified'] } }).lean(),
    Withdrawal.find({ status: 'paid' }).lean(),
  ]);
  const accounts = accountRows.map(account => accountSummary(account, entries, profits, settings.profitThroughMonth));
  const totals = fundTotals({ payments, accounts, submissions, withdrawals });
  return { settings, members, payments, accounts, entries, profits, projects, submissions, withdrawals, totals };
}

/** A member with dues, balances and profit share, as shown to staff and members. */
export function memberAccount(ledger, member) {
  const dues = memberDues(member, ledger.payments, ledger.settings);
  const withdrawn = sum(ledger.withdrawals.filter(row => String(row.memberId) === String(member._id)), row => row.amount);
  return { ...dues, dueTotal: dues.dueAmount, paidTotal: dues.paidAmount, withdrawn, ...memberShare(dues.paidAmount, ledger.totals, withdrawn) };
}

export const allDues = ledger => ledger.members.filter(member => member.status !== 'pending')
  .map(member => ({ member, dues: memberDues(member, ledger.payments, ledger.settings) }));
