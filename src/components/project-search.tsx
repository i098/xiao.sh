"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { Panel } from "@/components/panel";
import type { Project } from "@/lib/projects";
import { tuiNavigate } from "@/lib/navigate";
import { EXTERNAL_LINK_ARROW, UP_ARROW } from "@/lib/symbols";

type ProjectSearchProps = {
  projects: Project[];
  mode?: "full" | "search" | "cards";
  className?: string;
  query?: string;
  onQueryChange?: (value: string) => void;
};

const GHOST_SUGGESTIONS = [
  "ask about my top hackathon wins",
  "email me about a coffee chat next week",
  "find projects using next.js and ai",
];

function ProjectCardImage({ project }: { project: Project }) {
  const [src, setSrc] = useState(project.image);

  return (
    <Image
      src={src}
      alt={project.title}
      fill
      className="object-cover"
      onError={() => {
        if (project.fallbackImage && src !== project.fallbackImage) {
          setSrc(project.fallbackImage);
        }
      }}
    />
  );
}

function scoreProject(project: Project, terms: string[]) {
  let score = 0;

  for (const term of terms) {
    if (project.title.toLowerCase().includes(term)) score += 3;
    if (project.tags.some((tag) => tag.toLowerCase().includes(term))) score += 2;
    if (project.summary.toLowerCase().includes(term)) score += 1;
    if (project.highlight?.toLowerCase().includes(term)) score += 1;
  }

  return score;
}

export default function ProjectSearch({
  projects,
  mode = "full",
  className = "",
  query: controlledQuery,
  onQueryChange,
}: ProjectSearchProps) {
  const [internalQuery, setInternalQuery] = useState("");
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [typedChars, setTypedChars] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);
  const showSearch = mode !== "cards";
  const showCards = mode !== "search";
  const query = controlledQuery ?? internalQuery;
  const hasInput = query.trim().length > 0;

  function setQuery(next: string) {
    if (controlledQuery === undefined) {
      setInternalQuery(next);
    }
    onQueryChange?.(next);
  }
  const helperText =
    mode === "full"
      ? "Press Enter or send to open chat. Typing also filters project cards below."
      : "Dual mode: typing filters project cards below, Enter/send opens AI chat.";

  const filteredProjects = useMemo(() => {
    const terms = query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    if (terms.length === 0) return projects;

    return projects
      .map((project) => ({
        project,
        score: scoreProject(project, terms),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.project);
  }, [projects, query]);

  const activeSuggestion = GHOST_SUGGESTIONS[suggestionIndex] ?? GHOST_SUGGESTIONS[0] ?? "";
  const ghostText = hasInput ? "" : activeSuggestion.slice(0, typedChars);
  const inputPlaceholder = hasInput ? "ask about me or search projects..." : ghostText;

  useEffect(() => {
    if (hasInput) {
      setTypedChars(0);
      setIsDeleting(false);
    }
  }, [hasInput]);

  useEffect(() => {
    if (hasInput || !activeSuggestion) return;

    const fullLength = activeSuggestion.length;
    let timeoutMs = 80;
    if (!isDeleting && typedChars < fullLength) timeoutMs = 65;
    if (!isDeleting && typedChars === fullLength) timeoutMs = 1400;
    if (isDeleting && typedChars > 0) timeoutMs = 35;
    if (isDeleting && typedChars === 0) timeoutMs = 260;

    const timeout = window.setTimeout(() => {
      if (!isDeleting && typedChars < fullLength) {
        setTypedChars((value) => value + 1);
        return;
      }

      if (!isDeleting && typedChars >= fullLength) {
        setIsDeleting(true);
        return;
      }

      if (isDeleting && typedChars > 0) {
        setTypedChars((value) => value - 1);
        return;
      }

      if (isDeleting && typedChars === 0) {
        setIsDeleting(false);
        setSuggestionIndex((index) => (index + 1) % GHOST_SUGGESTIONS.length);
      }
    }, timeoutMs);

    return () => window.clearTimeout(timeout);
  }, [activeSuggestion, hasInput, isDeleting, typedChars]);

  function openChat(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return;
    tuiNavigate(`/chat?q=${encodeURIComponent(trimmedQuery)}`);
  }

  return (
    <section id={showSearch ? "search" : undefined} className={className}>
      {showSearch && (
        <Panel title="ai-search" index={2}>
          <form onSubmit={openChat} className="flex flex-col gap-2 md:flex-row">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={inputPlaceholder}
              className="w-full border border-[var(--line)] bg-[var(--panel-2)] px-3 py-2 text-sm text-[var(--text)] outline-none placeholder:text-[var(--muted)] focus:border-[var(--accent)]"
              aria-label="Search projects or ask about Jerry Xiao"
            />
            <button
              type="submit"
              disabled={query.trim().length === 0}
              aria-label="Send question"
              className="grid h-10 w-10 place-items-center border border-[var(--line)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="text-base leading-none">{UP_ARROW}</span>
            </button>
          </form>
          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="text-xs text-[var(--muted)]">{helperText}</p>
            <button
              type="button"
              onClick={() => tuiNavigate("/chat")}
              className="shrink-0 border border-[var(--line)] px-2 py-1 text-[11px] uppercase tracking-[0.12em] text-[var(--muted)] hover:text-[var(--text)]"
            >
              Open Chat {EXTERNAL_LINK_ARROW}
            </button>
          </div>
        </Panel>
      )}

      {showCards && (
        <>
          <div className={`${showSearch ? "mt-4 " : ""}grid gap-4 md:grid-cols-2 lg:grid-cols-3`}>
            {filteredProjects.map((project) => (
              <article key={project.title} className="border border-[var(--line)] bg-[var(--panel)]">
                <div className="relative h-48 w-full border-b border-[var(--line)]">
                  <ProjectCardImage project={project} />
                </div>
                <div className="p-4">
                  {project.highlight && (
                    <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--accent)]">
                      {project.highlight}
                    </p>
                  )}
                  <h3 className="text-lg font-semibold tracking-tight">{project.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">{project.summary}</p>
                  <p className="mt-3 text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
                    {project.tags.join(" · ")}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <a
                      href={project.githubUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-block border border-[var(--line)] px-2 py-1 text-xs uppercase tracking-[0.1em] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                    >
                      GitHub {EXTERNAL_LINK_ARROW}
                    </a>
                    {project.linkedinUrl && (
                      <a
                        href={project.linkedinUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-block border border-[var(--line)] px-2 py-1 text-xs uppercase tracking-[0.1em] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                      >
                        LinkedIn {EXTERNAL_LINK_ARROW}
                      </a>
                    )}
                    {project.eventUrl && (
                      <a
                        href={project.eventUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-block border border-[var(--line)] px-2 py-1 text-xs uppercase tracking-[0.1em] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                      >
                        Event {EXTERNAL_LINK_ARROW}
                      </a>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>

          {filteredProjects.length === 0 && (
            <div className="mt-4 border border-[var(--line)] bg-[var(--panel)] p-4 text-sm text-[var(--muted)]">
              No matches. Try a broader search term.
            </div>
          )}
        </>
      )}
    </section>
  );
}
