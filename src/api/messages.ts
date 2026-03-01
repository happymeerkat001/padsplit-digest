import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { SchemaError, graphqlRequest } from './client.js';
import type { InboxMessage } from './tickets.js';
import { logger } from '../utils/logger.js';

const GRAPHQL_ENDPOINT = '/api/graphql/';
const OPERATION_NAME = 'HostCommunicationConversations';
// const CONVERSATIONS_QUERY = `
// query HostCommunicationConversations($first: Int) {
//   hostConversations(first: $first) {
//     edges {
//       node {
//         id
//         subject
//         url
//         updatedAt
//         property {
//           address
//         }
//         latestMessage {
//           body
//           createdAt
//           sender {
//             fullName
//             name
//           }
//         }
//       }
//     }
//   }
// }
// `;

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

function summarizeShape(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 1500);
  } catch {
    return '[unserializable]';
  }
}

function resolveConversationNodes(data: unknown): Record<string, unknown>[] {
  const root = asRecord(data);
  if (!root) {
    throw new SchemaError('GraphQL data is not an object');
  }

  const hostConversations = asRecord(root['hostConversations']) ?? asRecord(root['conversations']);
  if (!hostConversations) {
    throw new SchemaError('GraphQL data missing conversations container');
  }

  const edges = hostConversations['edges'];
  if (!Array.isArray(edges)) {
    throw new SchemaError('GraphQL conversations missing edges array');
  }

  const nodes = edges
    .map((edge) => asRecord(edge))
    .map((edge) => asRecord(edge?.['node']))
    .filter((node): node is Record<string, unknown> => Boolean(node));

  return nodes;
}

export async function fetchMessages(): Promise<InboxMessage[]> {
  logger.info("Conversations temporarily disabled (schema change)");
  return [];
}

