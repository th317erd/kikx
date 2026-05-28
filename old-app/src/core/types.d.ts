// =============================================================================
// Kikx Core Type Definitions
// =============================================================================
// Shared interfaces for all data shapes used across the core system.
// Referenced by JSDoc annotations in .mjs files via @type {import('./types').X}
// =============================================================================

// ---------------------------------------------------------------------------
// Encrypted Envelope (AES-256-GCM)
// ---------------------------------------------------------------------------

export interface EncryptedEnvelope {
  ciphertext: string;
  iv: string;
  authTag: string;
}

// ---------------------------------------------------------------------------
// Model Instances
// ---------------------------------------------------------------------------

export interface Organization {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface User {
  id: string;
  organizationID: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatar: string | null;
  passwordSlot: string | null;
  publicKey: string | null;
  encryptedPrivateKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  organization?: Organization;
  getDisplayName(): string;
  getSettings(): Promise<Record<string, any>>;
  updateSettings(partial: Record<string, any>, keystore: Keystore, privateKeyPEM: string): Promise<void>;
  getVerifiedSettings(keystore: Keystore, publicKeyPEM: string): Promise<Record<string, any> | null>;
}

export interface Agent {
  id: string;
  organizationID: string;
  name: string;
  pluginID: string;
  model?: string;
  maxTokens?: number;
  thinkingBudget?: number;
  encryptedAPIKey: string | null;
  apiKey?: string;
  instructions: string | null;
  dmSummary: string | null;
  publicKey: string | null;
  encryptedPrivateKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  organization?: Organization;
  getConfig(): Promise<Record<string, any>>;
  setConfig(value: Record<string, any>): Promise<void>;
  updateConfig(partial: Record<string, any>): Promise<void>;
  getBehaviors(): Promise<string | null>;
  setBehaviors(text: string): Promise<void>;
  hasBehaviors(): Promise<boolean>;
  getSafeConfig(): Promise<Record<string, any>>;
}

export interface Session {
  id: string;
  organizationID: string;
  name: string;
  type: 'chat' | 'dm' | 'self' | string;
  dmAgentID: string | null;
  archived: boolean;
  parentSessionID: string | null;
  linkedFrameID: string | null;
  maxInteractions: number | null;
  endsAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  organization?: Organization;
  participants?: Participant[];
  parentSession?: Session;
  children?: Session[];
  getContext(): Promise<Record<string, any>>;
  setContext(value: Record<string, any>): Promise<void>;
  updateContext(partial: Record<string, any>): Promise<void>;
  getEffectiveContext(): Promise<Record<string, any>>;
}

export interface Participant {
  id: string;
  sessionID: string;
  agentID: string;
  role: 'coordinator' | 'member' | string;
  createdAt: Date;
  updatedAt: Date;
  session?: Session;
  agent?: Agent;
}

export interface FrameData {
  id: string;
  sessionID?: string;
  interactionID: string;
  parentID: string | null;
  order?: number;
  groupID?: string | null;
  groupType?: string | null;
  type: FrameType;
  content: Record<string, any> | string | null;
  targets?: string[] | null;
  authorType: 'user' | 'agent' | 'system';
  authorID: string | null;
  hidden: boolean;
  deleted: boolean;
  processed: boolean;
  processedAt?: Date | null;
  phantom?: boolean;
  signature: string | null;
  signingKeyFingerprint: string | null;
  state?: Record<string, any> | null;
  timestamp: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export type FrameType =
  | 'UserMessage'
  | 'Message'
  | 'ToolCall'
  | 'ToolResult'
  | 'ToolError'
  | 'ToolActivity'
  | 'PermissionRequest'
  | 'PermissionDenied'
  | 'CommandResult'
  | 'SessionLink'
  | 'HookBlocked'
  | 'PendingAction'
  | 'SystemError'
  | 'ParticipantJoined'
  | 'ParticipantLeft'
  | 'Error'
  | 'Reflection'
  | 'Compaction'
  | 'Stop'
  | string;

export interface Token {
  id: string;
  organizationID: string;
  sessionID: string;
  agentID: string | null;
  interactionID: string;
  serviceType: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ValueStoreEntry {
  id: string;
  organizationID: string;
  ownerType: string;
  ownerID: string;
  namespace: string;
  scopeID: string;
  key: string;
  value: string | null;
  signature: string | null;
  signingKeyFingerprint: string | null;
  note: string | null;
  type: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PermissionRule {
  id: string;
  organizationID: string;
  featureName: string;
  effect: 'allow' | 'deny';
  scope: 'global' | 'session' | 'frame';
  scopeID: string | null;
  metadata: string | null;
  priority: number;
  createdBy: string;
  fingerprint: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Role {
  id: string;
  organizationID: string;
  userID: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Core Models Registry (from core.getModels())
// ---------------------------------------------------------------------------

export interface CoreModels {
  User: any;
  Organization: any;
  Agent: any;
  Session: any;
  Frame: any;
  Participant: any;
  Token: any;
  ValueStore: any;
  PermissionRule: any;
  Role: any;
}

// ---------------------------------------------------------------------------
// Interaction System
// ---------------------------------------------------------------------------

export interface StartInteractionParams {
  userMessage?: string;
  agent?: Agent;
  agentPlugin?: BasePluginClass;
  authorType?: 'user' | 'agent' | 'system';
  authorID?: string | null;
  parentID?: string | null;
  agentCount?: number;
  convertMarkdown?: boolean;
  replayFromPermission?: boolean;
  checkPermission?: (featureName: string, toolArgs: any) => Promise<boolean>;
  executeTool?: (toolName: string, toolArgs: any) => Promise<any>;
  userPrivateKey?: string | null;
  userPublicKey?: string | null;
  _signingContext?: SigningContext;
}

export interface SigningContext {
  agentPrivateKey?: string | null;
  agentPublicKey?: string | null;
  userPrivateKey?: string | null;
  userPublicKey?: string | null;
}

export interface FrameUpdate {
  id: string;
  hidden?: boolean;
  deleted?: boolean;
  processed?: boolean;
  content?: Record<string, any>;
  state?: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Message History
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | MessageContentBlock[];
  frameID?: string;
  sourceAgentID?: string;
}

export interface MessageContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: any;
  tool_use_id?: string;
  content?: string;
}

// ---------------------------------------------------------------------------
// Plugin System
// ---------------------------------------------------------------------------

export interface ModelDescriptor {
  id: string;
  contextWindow: number;
  maxOutputTokens: number;
  displayName: string;
  description?: string;
  pricePerToken?: { input: number; output: number };
  useWhen?: string;
}

export interface TruncateOptions {
  systemPromptText?: string;
  behaviorsText?: string;
  instructionsText?: string;
  onOverflow?: (type: string) => Promise<void>;
}

export interface CompactionStats {
  totalChars: number;
  estimatedTokens: number;
  contextWindow: number;
  modelID: string;
  sessionID: string;
}

export interface PluginSetupContext {
  registerTool: (name: string, ToolClass: any) => void;
  registerCommand?: (name: string, handler: Function, help?: string) => void;
  registerCapability?: (name: string, options: any) => void;
  registerSelector?: (selector: string, PluginClass: any, pluginName?: string) => void;
  registerInstructions?: (pluginName: string, content: string, options?: { priority?: number }) => void;
  PluginInterface: any;
  AgentInterface?: any;
  registerAgentType?: (id: string, AgentClass: any) => void;
  context: CascadingContext;
}

export interface JSONSchema {
  type: string;
  properties?: Record<string, any>;
  required?: string[];
  description?: string;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export interface ResolveContext {
  keystore?: Keystore;
  umk?: Buffer;
  userID?: string;
  sessionID?: string;
}

export interface Commit {
  id: string;
  changes: Array<{ frameID: string; operation: string }>;
  authorType: 'user' | 'agent' | 'system';
  authorID: string | null;
  frames?: FrameData[];
}

// ---------------------------------------------------------------------------
// Crypto / Keystore
// ---------------------------------------------------------------------------

export interface Keystore {
  initialize(): void;
  destroy(): void;
  isInitialized(): boolean;
  loadServerMasterKey(configDir: string): void;
  generateSigningKeyPair(): { publicKey: string; privateKey: string };
  signWithPrivateKey(data: string | object, privateKeyPEM: string): string;
  verifyWithPublicKey(data: string | object, publicKeyPEM: string, signatureHex: string): boolean;
  encryptActorPrivateKey(privateKeyPEM: string, actorID: string): EncryptedEnvelope;
  decryptActorPrivateKey(encryptedData: EncryptedEnvelope, actorID: string): string;
  encryptUserPrivateKey(privateKeyPEM: string, umk: Buffer, userID: string): EncryptedEnvelope;
  decryptUserPrivateKey(encryptedData: EncryptedEnvelope, umk: Buffer, userID: string): string;
  loadSystemKeyPair(configDir: string): void;
  systemSign(data: string | object): string;
  systemVerify(data: string | object, signatureHex: string): boolean;
  getSystemPublicKey(): string;
  encrypt(plaintext: string | Buffer, key?: Buffer): EncryptedEnvelope;
  decrypt(encryptedData: EncryptedEnvelope, key?: Buffer): Buffer;
  wrapUMK(umk: Buffer): EncryptedEnvelope;
  unwrapUMK(wrappedUMK: EncryptedEnvelope): Buffer;
  generateUMK(): Buffer;
  derivePasswordSlotKey(password: string, salt?: Buffer | string): Promise<{ key: Buffer; salt: string }>;
  deriveUserKey(umk: Buffer, userID: string): Buffer;
  canonicalize(data: object): string;
}

// ---------------------------------------------------------------------------
// Frame Persistence
// ---------------------------------------------------------------------------

export interface LoadFramesOptions {
  interactionID?: string;
  afterOrder?: number;
  beforeOrder?: number;
  parentID?: string;
  limit?: number;
  metadataOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Tool Log
// ---------------------------------------------------------------------------

export interface ToolLogStoreParams {
  sessionID: string;
  interactionID: string;
  agentID: string;
  organizationID: string;
  toolName: string;
  pluginID: string;
  toolCallArgs: Record<string, any> | null;
  output: any;
  models: CoreModels;
  keystore?: Keystore | null;
  privateKeyPEM?: string | null;
  publicKeyPEM?: string | null;
}

export interface ToolLogPointer {
  stored: true;
  tool_log_id: string;
  output_length: number;
  message: string;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface CascadingContext {
  getProperty(name: string): any;
  setProperty(name: string, value: any): void;
}

// ---------------------------------------------------------------------------
// Generator Blocks (yielded by agent plugins)
// ---------------------------------------------------------------------------

export interface GeneratorBlock {
  type: 'message' | 'tool-call' | 'tool-result' | 'reflection' | 'reflection-delta' | 'delta' | 'usage' | 'done';
  content?: any;
  authorType?: string;
  authorID?: string;
}

export interface UsageData {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

// ---------------------------------------------------------------------------
// SSE Events
// ---------------------------------------------------------------------------

export interface SSEUsageEvent {
  interactionID: string;
  usage: UsageData;
  serviceType: string | null;
  isFinal: boolean;
}

export interface SSEDeltaEvent {
  interactionID: string;
  content: { text?: string };
  authorType: string | null;
  authorID: string | null;
}

// ---------------------------------------------------------------------------
// Base Plugin Class (for JSDoc @extends references)
// ---------------------------------------------------------------------------

export interface BasePluginClass {
  context: any;
  state: any;
  logger: any;
  _agent?: Agent;
  process(next: Function, done: Function): Promise<any>;
  checkPermission(toolName: string, params: any): Promise<{ approved: boolean; signature?: string; reason?: string }>;
  shouldCompact(stats: CompactionStats): { compact: boolean; reason: string };
  getCompactionPrompt(stats: CompactionStats): string;
  getMaxCompactionTokens(stats: CompactionStats): number;
  truncate(messages: ChatMessage[], options?: TruncateOptions): Promise<ChatMessage[]>;
  estimateTokens(text: string, options?: { cache?: boolean }): number;
}
