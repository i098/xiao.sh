"use client";

import ProjectSearch from "@/components/project-search";
import SpotifyNowPlaying from "@/components/spotify-now-playing";
import { Panel } from "@/components/panel";
import Scramble from "@/components/scramble";
import { TransitionLink } from "@/components/transition-link";
import { profile } from "@/lib/profile";
import { projects } from "@/lib/projects";
import { EXTERNAL_LINK_ARROW } from "@/lib/symbols";
import { useState } from "react";

export default function Home() {
  const [searchQuery, setSearchQuery] = useState("");

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-5 py-10 md:px-8 md:py-12">
      <Panel title="session" index={0} className="mb-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-2 leading-none">
            <p className="text-sm font-medium tracking-tight text-[var(--accent)]">xiao.sh</p>
            <span aria-hidden="true" className="h-3 w-px bg-[var(--line)]" />
            <p className="relative top-px text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">
              synced with github
            </p>
          </div>
          <nav className="flex items-center gap-3 text-[11px] uppercase tracking-[0.14em] text-[var(--muted)]">
            <a href="#search" className="tui-chip">
              search
            </a>
            <TransitionLink href="/about" className="tui-chip">
              about
            </TransitionLink>
            <a href={profile.links.github} target="_blank" rel="noreferrer" className="tui-chip">
              github {EXTERNAL_LINK_ARROW}
            </a>
          </nav>
        </div>
      </Panel>

      <Panel title="~/jerry" index={1}>
        <div className="flex flex-col gap-5 md:grid md:grid-cols-[minmax(0,1fr)_18rem] md:items-start md:gap-6">
          <div className="min-w-0">
            <p className="text-xs text-[var(--muted)]">
              <span className="text-[var(--accent)]">$</span> whoami
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">
              <Scramble text={profile.name} />
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-relaxed text-[var(--muted)] md:text-base">
              CS @ {profile.education} class of 2029. {profile.bio} This site keeps things minimal: quick context,
              searchable projects, and direct links. Take a look at the stuff I've worked on below :)
            </p>
            <ProjectSearch
              projects={projects}
              mode="search"
              className="mt-4 max-w-3xl"
              query={searchQuery}
              onQueryChange={setSearchQuery}
            />
          </div>

          <SpotifyNowPlaying className="w-full max-w-[18rem] md:justify-self-end md:mt-2 md:w-[18rem] md:max-w-none" />
        </div>
      </Panel>

      <ProjectSearch projects={projects} mode="cards" className="mt-6" query={searchQuery} />
    </main>
  );
}
