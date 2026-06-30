"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Panel } from "@/components/panel";
import { tuiNavigate } from "@/lib/navigate";
import { EXTERNAL_LINK_ARROW, UP_ARROW } from "@/lib/symbols";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  isError?: boolean;
  isPending?: boolean;
  model?: string;
  action?: ChatAction;
};

type ChatAction = {
  type: "email_compose";
  href: string;
  label?: string;
  to?: string;
  subject?: string;
  body?: string;
  autoOpen?: boolean;
};

type ChatApiResponse = {
  answer?: string;
  error?: string;
  model?: string;
  action?: ChatAction;
};

type PendingChatRequest = {
  requestId: string;
  pendingMessageId: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  createdAt: number;
};

const CHAT_STORAGE_KEY = "xiao.sh:chat-history:v1";
const CHAT_PENDING_KEY = "xiao.sh:chat-pending:v1";
const MAX_INJECTED_MESSAGES = 50;

const activeRequests = new Set<string>();

function createMessageId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeStoredMessages(raw: unknown) {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((message) => typeof message === "object" && message !== null)
    .map((message) => message as Partial<ChatMessage>)
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      id: typeof message.id === "string" && message.id.length > 0 ? message.id : createMessageId(),
      role: message.role as "user" | "assistant",
      content: typeof message.content === "string" ? message.content : "",
      isError: Boolean(message.isError),
      isPending: Boolean(message.isPending),
      model: typeof message.model === "string" ? message.model : undefined,
      action:
        message.action &&
        typeof message.action === "object" &&
        (message.action as Partial<ChatAction>).type === "email_compose" &&
        typeof (message.action as Partial<ChatAction>).href === "string" &&
        ((message.action as Partial<ChatAction>).href?.startsWith("mailto:") ?? false)
          ? ({
              type: "email_compose",
              href: (message.action as Partial<ChatAction>).href as string,
              label:
                typeof (message.action as Partial<ChatAction>).label === "string"
                  ? (message.action as Partial<ChatAction>).label
                  : `Open draft ${EXTERNAL_LINK_ARROW}`,
              to:
                typeof (message.action as Partial<ChatAction>).to === "string"
                  ? (message.action as Partial<ChatAction>).to
                  : undefined,
              subject:
                typeof (message.action as Partial<ChatAction>).subject === "string"
                  ? (message.action as Partial<ChatAction>).subject
                  : undefined,
              body:
                typeof (message.action as Partial<ChatAction>).body === "string"
                  ? (message.action as Partial<ChatAction>).body
                  : undefined,
            } satisfies ChatAction)
          : undefined,
    }))
    .filter((message) => message.content.trim().length > 0 || message.isPending);
}

function readStoredMessages() {
  try {
    const raw = window.localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return normalizeStoredMessages(parsed);
  } catch {
    return [];
  }
}

function writeStoredMessages(messages: ChatMessage[]) {
  try {
    window.localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages));
  } catch {
    // Ignore localStorage write failures.
  }
}

function readPendingRequest() {
  try {
    const raw = window.localStorage.getItem(CHAT_PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingChatRequest>;
    if (
      typeof parsed.requestId !== "string" ||
      typeof parsed.pendingMessageId !== "string" ||
      !Array.isArray(parsed.messages)
    ) {
      return null;
    }

    const messages = parsed.messages
      .filter((message) => message?.role === "user" || message?.role === "assistant")
      .map((message) => ({
        role: message.role as "user" | "assistant",
        content: typeof message.content === "string" ? message.content : "",
      }))
      .filter((message) => message.content.trim().length > 0)
      .slice(-MAX_INJECTED_MESSAGES);

    if (messages.length === 0) return null;

    return {
      requestId: parsed.requestId,
      pendingMessageId: parsed.pendingMessageId,
      messages,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
    } as PendingChatRequest;
  } catch {
    return null;
  }
}

function writePendingRequest(pendingRequest: PendingChatRequest) {
  try {
    window.localStorage.setItem(CHAT_PENDING_KEY, JSON.stringify(pendingRequest));
  } catch {
    // Ignore localStorage write failures.
  }
}

function clearPendingRequest() {
  try {
    window.localStorage.removeItem(CHAT_PENDING_KEY);
  } catch {
    // Ignore localStorage write failures.
  }
}

export default function ChatClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialQuestion = searchParams.get("q")?.trim() ?? "";

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);

  const initializedRef = useRef(false);
  const mountedRef = useRef(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  const endRef = useRef<HTMLDivElement | null>(null);

  function applyMessages(nextMessages: ChatMessage[]) {
    messagesRef.current = nextMessages;
    writeStoredMessages(nextMessages);
    if (mountedRef.current) {
      setMessages(nextMessages);
    }
  }

  function resolvePendingMessage(
    pendingMessageId: string,
    patch: Partial<Pick<ChatMessage, "content" | "isError" | "isPending" | "model" | "action">>,
  ) {
    const current = readStoredMessages();
    let found = false;

    const next = current.map((message) => {
      if (message.id !== pendingMessageId) return message;
      found = true;
      return { ...message, ...patch };
    });

    if (!found && patch.content) {
      next.push({
        id: pendingMessageId,
        role: "assistant",
        content: patch.content,
        isError: Boolean(patch.isError),
        isPending: Boolean(patch.isPending),
        model: patch.model,
        action: patch.action,
      });
    }

    applyMessages(next);
  }

  async function executePendingRequest(pendingRequest: PendingChatRequest) {
    if (activeRequests.has(pendingRequest.requestId)) {
      // Another mounted instance is already handling this request; wait and sync storage.
      for (let i = 0; i < 120; i += 1) {
        if (!activeRequests.has(pendingRequest.requestId)) break;
        await sleep(100);
      }

      const synced = readStoredMessages();
      applyMessages(synced);
      if (!readPendingRequest() && mountedRef.current) setIsSending(false);
      return;
    }
    activeRequests.add(pendingRequest.requestId);

    if (mountedRef.current) setIsSending(true);

    try {
      const response = await fetch("/api/ai-search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: pendingRequest.messages,
        }),
      });

      const data = (await response.json()) as ChatApiResponse;
      if (!response.ok) {
        throw new Error(data.error || "Failed to get AI response.");
      }

      // If chat was cleared while request was in-flight, ignore stale result.
      const activePending = readPendingRequest();
      if (!activePending || activePending.requestId !== pendingRequest.requestId) {
        return;
      }

      const action =
        data.action?.type === "email_compose" &&
        typeof data.action.href === "string" &&
        data.action.href.startsWith("mailto:")
          ? { ...data.action, autoOpen: false }
          : undefined;

      resolvePendingMessage(pendingRequest.pendingMessageId, {
        content: data.answer || "No response.",
        isPending: false,
        isError: false,
        model: data.model,
        action,
      });

      clearPendingRequest();

      if (data.action?.type === "email_compose" && data.action.autoOpen && data.action.href.startsWith("mailto:")) {
        window.location.href = data.action.href;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to get AI response.";

      const activePending = readPendingRequest();
      if (!activePending || activePending.requestId !== pendingRequest.requestId) {
        return;
      }

      resolvePendingMessage(pendingRequest.pendingMessageId, {
        content: message,
        isPending: false,
        isError: true,
      });

      clearPendingRequest();
    } finally {
      activeRequests.delete(pendingRequest.requestId);
      if (mountedRef.current) setIsSending(false);
    }
  }

  async function sendMessage(rawContent: string) {
    const content = rawContent.trim();
    if (!content || isSending) return;

    const userMessage: ChatMessage = {
      id: createMessageId(),
      role: "user",
      content,
    };

    const pendingMessage: ChatMessage = {
      id: createMessageId(),
      role: "assistant",
      content: "Thinking",
      isPending: true,
    };

    const nextMessages = [...messagesRef.current, userMessage, pendingMessage];
    applyMessages(nextMessages);
    setInput("");
    setIsSending(true);

    const requestMessages = nextMessages
      .filter((message) => !message.isPending && !message.isError)
      .slice(-MAX_INJECTED_MESSAGES)
      .map((message) => ({
        role: message.role,
        content: message.content,
      }));

    const pendingRequest: PendingChatRequest = {
      requestId: createMessageId(),
      pendingMessageId: pendingMessage.id,
      messages: requestMessages,
      createdAt: Date.now(),
    };

    writePendingRequest(pendingRequest);
    void executePendingRequest(pendingRequest);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage(input);
  }

  function clearChat() {
    clearPendingRequest();
    applyMessages([]);
    setInput("");
    setIsSending(false);
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const stored = readStoredMessages();
    messagesRef.current = stored;
    setMessages(stored);

    const pendingRequest = readPendingRequest();
    if (pendingRequest) {
      setIsSending(true);
      void executePendingRequest(pendingRequest);
    }

    setIsHydrated(true);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isSending]);

  useEffect(() => {
    if (!isHydrated) return;
    if (initializedRef.current) return;
    initializedRef.current = true;

    if (!initialQuestion) return;

    const alreadyAsked = messagesRef.current.some(
      (message) => message.role === "user" && message.content.trim() === initialQuestion,
    );

    if (!alreadyAsked) {
      void sendMessage(initialQuestion);
    }

    router.replace("/chat");
  }, [initialQuestion, isHydrated, router]);

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl px-5 py-10 md:px-8 md:py-12">
      <Panel title="session" index={0} className="mb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button onClick={() => tuiNavigate("/")} className="tui-chip flex items-center gap-1 text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                className="h-3.5 w-3.5"
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 12H5m0 0 6-6m-6 6 6 6" />
              </svg>
              <span>cd ~</span>
            </button>
            <button onClick={clearChat} className="tui-chip text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
              clear chat
            </button>
          </div>
          <div className="text-right">
            <p className="text-sm font-medium tracking-tight text-[var(--accent)]">ask about me</p>
            <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">synced with github</p>
          </div>
        </div>
      </Panel>

      <Panel title="chat" index={1}>
        <div className="max-h-[62vh] space-y-3 overflow-y-auto pr-1">
          {messages.length === 0 && (
            <p className="text-sm text-[var(--muted)]">
              Ask about Jerry, projects, hackathon wins, stack, or links.
            </p>
          )}

          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] border px-3 py-2 text-sm leading-relaxed ${
                  message.role === "user"
                    ? "border-[var(--accent)] bg-[var(--panel-2)]"
                    : "border-[var(--line)] bg-[var(--panel)]"
                } ${message.isError ? "text-[#fda4af]" : "text-[var(--text)]"} ${
                  message.isPending ? "text-[var(--muted)]" : ""
                }`}
              >
                {message.isPending ? (
                  <div className="flex items-center gap-1 text-[10px] uppercase tracking-[0.08em]">
                    <span>Thinking</span>
                    <span className="inline-block h-1 w-1 rounded-full bg-[var(--muted)] animate-pulse" />
                  </div>
                ) : (
                  <p className="whitespace-pre-line">{message.content}</p>
                )}
                {message.model && !message.isError && !message.isPending && (
                  <p className="mt-2 text-[10px] uppercase tracking-[0.12em] text-[var(--muted)]">
                    {message.model}
                  </p>
                )}
                {message.action?.type === "email_compose" && (
                  <div className="mt-2">
                    <a
                      href={message.action.href}
                      className="inline-block border border-[var(--line)] px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                    >
                      {message.action.label ?? `Open draft ${EXTERNAL_LINK_ARROW}`}
                    </a>
                  </div>
                )}
              </div>
            </div>
          ))}

          <div ref={endRef} />
        </div>

        <form onSubmit={handleSubmit} className="mt-4 flex gap-2">
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Ask a follow-up..."
            className="w-full border border-[var(--line)] bg-[var(--panel-2)] px-3 py-2 text-sm text-[var(--text)] outline-none placeholder:text-[var(--muted)] focus:border-[var(--accent)]"
            aria-label="Chat input"
          />
          <button
            type="submit"
            disabled={isSending || input.trim().length === 0}
            aria-label="Send message"
            className="grid h-10 w-10 place-items-center border border-[var(--line)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="text-base leading-none">{UP_ARROW}</span>
          </button>
        </form>
      </Panel>
    </main>
  );
}
