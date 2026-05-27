"use client";

import { FormEvent, useState } from "react";

interface PromptInputProps {
  onSubmit: (prompt: string) => Promise<void>;
  disabled?: boolean;
}

export default function PromptInput({ onSubmit, disabled }: PromptInputProps) {
  const [value, setValue] = useState("");

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <h2 className="text-base font-semibold text-slate-950 dark:text-slate-50">Prompt Input</h2>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Enter a natural language description and generate an app specification end-to-end.
      </p>
      <form
        className="mt-4 space-y-4"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          onSubmit(value.trim());
        }}
      >
        <textarea
          rows={5}
          className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-950 outline-none transition focus:border-slate-400 focus:bg-white dark:border-slate-800 dark:bg-slate-900 dark:text-slate-50 dark:placeholder:text-slate-500 dark:focus:border-slate-600 dark:focus:bg-slate-950"
          placeholder="CRM for managing deals with WhatsApp notifications when a deal closes..."
          value={value}
          onChange={(event) => setValue(event.target.value)}
          disabled={disabled}
        />
        <button
          type="submit"
          disabled={disabled || value.trim().length < 10}
          className="inline-flex min-h-10 items-center justify-center rounded-lg bg-slate-950 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400 dark:bg-slate-100 dark:text-slate-950 dark:hover:bg-white dark:disabled:bg-slate-700 dark:disabled:text-slate-400"
        >
          {disabled ? "Running..." : "Generate App Spec"}
        </button>
      </form>
    </section>
  );
}
