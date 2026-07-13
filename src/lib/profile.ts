export type Profile = {
  name: string;
  role: string;
  dob?: string;
  location: string;
  bio: string;
  education: string;
  skills: string[];
  links: {
    github: string;
    linkedin: string;
    email: string;
  };
};

export const profile: Profile = {
  name: "Jerry Xiao",
  role: "CS Student + Builder",
  dob: "09/30/2007",
  location: "Boston, MA",
  bio: "",
  education: "Northeastern University",
  skills: [
    "TypeScript",
    "Python",
    "Java",
    "Next.js",
    "Tailwind CSS",
    "Node.js",
    "Cloudflare",
    "AWS",
    "Redis",
    "FastAPI",
    "Docker",
    "Bun",
  ],
  links: {
    github: "https://github.com/undeemed",
    linkedin: "https://www.linkedin.com/in/xiaojerry/",
    email: "jerry@xiao.sh",
  },
};
