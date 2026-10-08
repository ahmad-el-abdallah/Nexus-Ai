"use client";

import Link from "next/link";
import { Children, isValidElement, memo, type ReactNode, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { extensionFor, runnableLanguage } from "@/lib/runs";

/** Asks to run a code block in the sandbox (the owner approves it in a dialog first). */
export type RunCode = (code: string, language: string) => void;

const base: Components = {
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

function codeOf(children: ReactNode): { code: string; tag: string } {
  const child = Children.toArray(children)[0];
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return { code: "", tag: "" };
  const tag = /language-([\w+#-]+)/.exec(child.props.className ?? "")?.[1] ?? "";
  const text = Children.toArray(child.props.children)
    .map((c) => (typeof c === "string" ? c : ""))
    .join("");
  return { code: text.replace(/\n$/, ""), tag };
}

const toolBtn = "rounded px-1.5 py-0.5 text-[11px] text-nx-muted ring-1 ring-nx-line-strong hover:bg-white/5 hover:text-nx-text";

/** A code block with Copy, Download and (for Python / JavaScript / Bash) Run. */
function CodeBlock({ children, onRun, finished }: { children: ReactNode; onRun?: RunCode; finished: boolean }) {
  const { code, tag } = codeOf(children);
  const [copied, setCopied] = useState(false);
  const runnable = onRun && finished && runnableLanguage(tag);
  const download = () => {
    const url = URL.createObjectURL(new Blob([code], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${runnable === "python" ? "main" : tag || "code"}.${extensionFor(tag)}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="nx-codeblock my-2 overflow-hidden rounded-lg ring-1 ring-nx-line" data-testid="code-block" data-language={tag}>
      <div className="flex items-center gap-1.5 bg-white/[0.04] px-2 py-1">
        <span className="mr-auto font-mono text-[11px] text-nx-faint">{tag || "code"}</span>
        <button
          type="button"
          className={toolBtn}
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" className={toolBtn} onClick={download}>
          Download
        </button>
        {runnable && (
          <button type="button" className="rounded bg-nx-cyan/15 px-2 py-0.5 text-[11px] font-semibold text-nx-cyan ring-1 ring-nx-cyan/50 hover:bg-nx-cyan/25" onClick={() => onRun(code, tag)}>
            ▶ Run
          </button>
        )}
      </div>
      <pre className="!my-0 !rounded-none">{children}</pre>
    </div>
  );
}

/** Renders Markdown safely: raw HTML is dropped and unsafe URLs are removed by react-markdown. */
export const Markdown = memo(function Markdown({ text, streaming = false, onRun }: { text: string; streaming?: boolean; onRun?: RunCode }) {
  const components = useMemo<Components>(
    () => ({
      ...base,
      pre: ({ children }) => (
        <CodeBlock onRun={onRun} finished={!streaming}>
          {children}
        </CodeBlock>
      ),
    }),
    [onRun, streaming],
  );
  return (
    <div dir="auto" className={`nx-markdown text-nx-text ${streaming ? "nx-caret" : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
