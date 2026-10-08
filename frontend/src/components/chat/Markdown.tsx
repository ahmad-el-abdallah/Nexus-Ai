"use client";

import Link from "next/link";
import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  // Links to pages of this app stay in the app; anything else opens outside it, without referrer.
  a: ({ href, children }) =>
    typeof href === "string" && href.startsWith("/") && !href.startsWith("//") ? (
      <Link href={href}>{children}</Link>
    ) : (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    ),
  // Never load remote images from model output; show the link instead.
  img: ({ src, alt }) => (
    <a href={typeof src === "string" ? src : undefined} target="_blank" rel="noopener noreferrer nofollow">
      [image: {alt || "link"}]
    </a>
  ),
};

/** Renders Markdown safely: raw HTML is dropped and unsafe URLs are removed by react-markdown. */
export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div dir="auto" className={`nx-markdown text-nx-text ${streaming ? "nx-caret" : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
