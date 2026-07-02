export type Project = {
  title: string;
  summary: string;
  tags: string[];
  image: string;
  fallbackImage?: string;
  githubUrl: string;
  linkedinUrl?: string;
  eventUrl?: string;
  highlight?: string;
};

export const projects: Project[] = [
  {
    title: "Interpreter",
    summary:
      "Audio translation everywhere and anywhere. Breaking the web's language barrier by translating any tab in real time.",
    tags: ["TypeScript", "Python", "CSS"],
    image: "/projects/choices/shlawgathon-interpreter/02.png",
    fallbackImage: "/projects/shlawgathon-interpreter.png",
    githubUrl: "https://github.com/shlawgathon/interpreter",
    linkedinUrl:
      "https://www.linkedin.com/posts/xiaojerry_exploring-the-features-of-a-live-translator-activity-7431220415206744064-0h-U?utm_source=share&utm_medium=member_desktop&rcm=ACoAAEerNM8BaiLwsyO2-11sjJzKRTO2VXWvfD4",
    eventUrl: "https://luma.com/0xgxtpdt?tk=FJOJQR",
    highlight: "Hackathon Top 3",
  },
  {
    title: "WebBrain",
    summary:
      "Your evolving digital memory. AI browser history recall that captures, compresses, and searches what you've visited.",
    tags: ["Java", "HTML", "JavaScript"],
    image: "/projects/choices/shlawgathon-webbrain/02.jpg",
    fallbackImage: "/projects/shlawgathon-webbrain.png",
    githubUrl: "https://github.com/shlawgathon/WebBrain",
    linkedinUrl:
      "https://www.linkedin.com/posts/xiaojerry_i-had-lots-of-fun-at-the-mongodb-agentic-activity-7383038759665164288-yzTn?utm_source=share&utm_medium=member_desktop&rcm=ACoAAEerNM8BaiLwsyO2-11sjJzKRTO2VXWvfD4",
    eventUrl: "https://cerebralvalley.ai/e/mongoDB-hackathon?tab=guest-list",
    highlight: "Hackathon Top 3",
  },
  {
    title: "Intercontinental Ballistic Gifts",
    summary:
      "A logistics platform where Santa can remotely send gifts using a nukemap-based route concept.",
    tags: ["TypeScript", "JavaScript", "CSS"],
    image: "/projects/linkedin-shlawgathon-icbg.jpg",
    fallbackImage: "/projects/shlawgathon-icbg.png",
    githubUrl: "https://github.com/shlawgathon/ICBG",
    linkedinUrl:
      "https://www.linkedin.com/posts/xiaojerry_last-night-we-aritra-saharay-wei-tu-and-activity-7406439444557443072-a_O6?utm_source=share&utm_medium=member_desktop&rcm=ACoAAEerNM8BaiLwsyO2-11sjJzKRTO2VXWvfD4",
    eventUrl: "https://luma.com/9ecbetao?tk=KZdXd4",
    highlight: "Hackathon Top 3",
  },
  {
    title: "BlueDocs",
    summary:
      "An interactive ocean planning tool with live status updates and environment mapping powered by Mapbox.",
    tags: ["TypeScript", "HTML", "Python"],
    image: "https://opengraph.githubassets.com/1/shlawgathon/BlueDocs",
    githubUrl: "https://github.com/shlawgathon/BlueDocs",
    highlight: "Hackathon Top 3",
  },
  {
    title: "Physical.ai",
    summary:
      "Analytics and marketplace platform for physical ads with real-time preview, transparent pricing, and impact scoring.",
    tags: ["TypeScript", "Python", "PLpgSQL"],
    image: "/projects/linkedin-shlawgathon-physical.jpg",
    fallbackImage: "/projects/shlawgathon-physical.png",
    githubUrl: "https://github.com/shlawgathon/Physical",
    linkedinUrl:
      "https://www.linkedin.com/posts/xiaojerry_within-24-hours-we-aritra-saharay-neil-activity-7421684534938767361-2Dxc?utm_source=share&utm_medium=member_desktop&rcm=ACoAAEerNM8BaiLwsyO2-11sjJzKRTO2VXWvfD4",
    eventUrl: "https://events.ycombinator.com/fullstackhackathon",
    highlight: "Hackathon Top 6",
  },
  {
    title: "ProductKit",
    summary:
      "Agentic workflow that turns product images into Shopify-ready listings with documentation and richer product media.",
    tags: ["TypeScript", "JavaScript", "CSS"],
    image: "/projects/choices/shlawgathon-productkit/02.png",
    fallbackImage: "/projects/shlawgathon-productkit.png",
    githubUrl: "https://github.com/shlawgathon/productkit",
    linkedinUrl:
      "https://www.linkedin.com/posts/xiaojerry_github-shlawgathonproductkit-an-agentic-activity-7398606880346030080-OeHb?utm_source=share&utm_medium=member_desktop&rcm=ACoAAEerNM8BaiLwsyO2-11sjJzKRTO2VXWvfD4",
    eventUrl: "https://cerebralvalley.ai/e/bfl-hackathon?tab=guest-list",
    highlight: "Hackathon Top 6",
  },
  {
    title: "SportsClips",
    summary:
      "Automated short-form sports highlights and live commentary pipeline with video chunking and AI detection.",
    tags: ["Python", "Swift", "TypeScript"],
    image: "/projects/choices/shlawgathon-sportsclips/04.jpg",
    fallbackImage: "/projects/shlawgathon-sportsclips.png",
    githubUrl: "https://github.com/shlawgathon/sportsclips",
    linkedinUrl:
      "https://www.linkedin.com/posts/xiaojerry_another-day-another-hackathon-shack15-activity-7385938406486437888-_u5O?utm_source=share&utm_medium=member_desktop&rcm=ACoAAEerNM8BaiLwsyO2-11sjJzKRTO2VXWvfD4",
    eventUrl: "https://cerebralvalley.ai/e/2025-ted-ai-hackathon?tab=guest-list",
    highlight: "Hackathon Top 6",
  },
  {
    title: "tactile",
    summary: "The ultimate multi-agent orchestrated CAD analysis and update platform.",
    tags: ["Java", "Python", "TypeScript"],
    image: "https://opengraph.githubassets.com/1/shlawgathon/tactile",
    githubUrl: "https://github.com/shlawgathon/tactile",
  },
  {
    title: "Computer-Use",
    summary: "Let AI steer your device. Turns natural language into real on-screen actions.",
    tags: ["Rust", "TypeScript", "CSS"],
    image: "https://opengraph.githubassets.com/1/shlawgathon/Computer-Use",
    githubUrl: "https://github.com/shlawgathon/Computer-Use",
  },
  {
    title: "ratemyhackathons",
    summary:
      "Whine, complain, compliment. Rate the hackathons you've survived - may the most memorable team win.",
    tags: ["Svelte", "Rust", "Python"],
    image: "https://opengraph.githubassets.com/1/undeemed/ratemyhackathons",
    githubUrl: "https://github.com/undeemed/ratemyhackathons",
  },
  {
    title: "ocd",
    summary:
      "Zero-tolerance audit-and-fix Claude Code plugin for visual polish and code quality. Measures rendered output, fixes every violation.",
    tags: ["JavaScript"],
    image: "https://opengraph.githubassets.com/1/undeemed/ocd",
    githubUrl: "https://github.com/undeemed/ocd",
  },
  {
    title: "walkthrough-kit",
    summary:
      "Claude Code plugin for spoken code-demo walkthroughs in isolated grader sandboxes: file-line pointers and portable commands.",
    tags: ["Markdown"],
    image: "https://opengraph.githubassets.com/1/undeemed/walkthrough-kit",
    githubUrl: "https://github.com/undeemed/walkthrough-kit",
  },
  {
    title: "get-shit-done-codex",
    summary:
      "A lightweight meta-prompting and spec-driven workflow system for Codex, adapted from the original get-shit-done.",
    tags: ["JavaScript"],
    image: "/projects/undeemed-get-shit-done-codex.png",
    githubUrl: "https://github.com/undeemed/get-shit-done-codex",
  },
  {
    title: "pyreflect-interface",
    summary:
      "Minimal monochrome web interface for pyreflect neutron reflectivity analysis, focused on practical research workflows.",
    tags: ["Python", "TypeScript", "CSS"],
    image: "/projects/pyreflect.png",
    fallbackImage: "/projects/northeastern-research-ornl-1-pyreflect-interface.png",
    githubUrl: "https://github.com/Northeastern-Research-ORNL-1/pyreflect-interface",
  },
  {
    title: "SEC-Tracker",
    summary:
      "Python CLI feed parser for SEC filings with AI-assisted analysis and custom filters for insider trade tracking.",
    tags: ["Python", "Shell"],
    image: "/projects/undeemed-sec-tracker.png",
    githubUrl: "https://github.com/undeemed/SEC-Tracker",
  },
];
