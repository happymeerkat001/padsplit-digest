import { DataIntegrityError, SchemaError, apiGet } from './client.js';
import { logger } from '../utils/logger.js';

const TICKETS_ENDPOINT = '/api/admin-new/property/maintenance/tickets/';

export interface InboxMessage {
  messageId: string;
  source: 'communication' | 'task';
  senderName: string;
  subject: string;
  body: string;
  messageUrl: string;
  timestamp: string;
}

export interface Ticket {
  id: string;
  propertyId: string;
  propertyAddress: string;
  status: string;
  description: string;
  createdAt: string;
  moveOutDate?: string;
  assignedTo?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function coerceIsoDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }
  return parsed.toISOString();
}

function pickTicketArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  const root = asRecord(payload);
  if (!root) {
    throw new SchemaError('Tickets response is not an array or object');
  }

  const directKeys = ['results', 'tickets', 'items'];
  for (const key of directKeys) {
    const value = root[key];
    if (Array.isArray(value)) {
      return value;
    }
  }

  const data = asRecord(root['data']);
  if (data) {
    for (const key of directKeys) {
      const value = data[key];
      if (Array.isArray(value)) {
        return value;
      }
    }
  }

  throw new SchemaError('Unable to locate tickets array in API response');
}

function normalizeTicket(raw: unknown): Ticket {
  const record = asRecord(raw);
  if (!record) {
    throw new SchemaError('Ticket entry is not an object');
  }

  const property = asRecord(record['property']);
  const assignee = asRecord(record['assigned_to']) ?? asRecord(record['assignedTo']);

  const id =
    asString(record['id']) ||
    asString(record['ticket_id']) ||
    asString(record['ticketId']) ||
    asString(record['uuid']);

  if (!id) {
    throw new SchemaError('Ticket missing id');
  }

  const propertyId =
    asString(record['property_id']) || asString(record['propertyId']) || asString(property?.['id']) || 'unknown';

  const propertyAddress =
    asString(record['property_address']) ||
    asString(record['propertyAddress']) ||
    asString(property?.['address']) ||
    asString(record['address']) ||
    'Unknown address';

  const status =
    asString(record['status']) || asString(record['ticket_status']) || asString(record['state']) || 'Unknown';

  const description =
    asString(record['description']) ||
    asString(record['details']) ||
    asString(record['summary']) ||
    asString(record['title']) ||
    '(No description)';

  const createdAtRaw =
    asString(record['created_at']) ||
    asString(record['createdAt']) ||
    asString(record['created']) ||
    asString(record['date_created']);

  const moveOutRaw =
    asString(record['move_out_date']) || asString(record['moveOutDate']) || asString(record['expected_move_out']);

  const assignedTo =
    asString(record['assigned_to_name']) ||
    asString(record['assignedToName']) ||
    asString(assignee?.['name']) ||
    asString(assignee?.['full_name']);

  return {
    id,
    propertyId,
    propertyAddress,
    status,
    description,
    createdAt: coerceIsoDate(createdAtRaw),
    moveOutDate: moveOutRaw ? coerceIsoDate(moveOutRaw) : undefined,
    assignedTo: assignedTo || undefined,
  };
}

export async function fetchTickets(): Promise<Ticket[]> {
  const startedAt = Date.now();
  const payload = await apiGet<unknown>(TICKETS_ENDPOINT);
  const rawTickets = pickTicketArray(payload);
  const tickets = rawTickets.map((raw) => normalizeTicket(raw));

  logger.info('PadSplit tickets fetched', {
    endpoint: TICKETS_ENDPOINT,
    durationMs: Date.now() - startedAt,
    count: tickets.length,
  });

  if (tickets.length === 0) {
    throw new DataIntegrityError('No tickets returned from PadSplit API');
  }

  return tickets;
}

export function ticketsToInboxMessages(tickets: Ticket[]): InboxMessage[] {
  return tickets.map((ticket) => {
    const bodyLines = [
      'Type: Maintenance Ticket',
      ticket.description,
      `Status: ${ticket.status}`,
      ticket.assignedTo ? `Assigned To: ${ticket.assignedTo}` : '',
      ticket.moveOutDate ? `Move Out Date: ${ticket.moveOutDate}` : '',
    ].filter(Boolean);

    return {
      messageId: `padsplit-${ticket.id}`,
      source: 'task',
      senderName: 'Task',
      subject: ticket.propertyAddress,
      body: bodyLines.join('\n'),
      messageUrl: `https://www.padsplit.com/host/tasks/${ticket.id}`,
      timestamp: ticket.createdAt,
    };
  });
}
