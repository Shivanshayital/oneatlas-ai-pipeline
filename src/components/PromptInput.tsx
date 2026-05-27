"use client";

import { FormEvent, useState } from "react";

interface PromptInputProps {
  onSubmit: (prompt: string) => Promise<void>;
  disabled?: boolean;
}

export default function PromptInput({ onSubmit, disabled }: PromptInputProps) {
  const [value, setValue] = useState("");

  return (
    <section className="rounded-xl border border-slate-300 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-900">Prompt Input</h2>
      <p className="mt-1 text-sm text-slate-600">
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
          className="w-full rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-500 focus:bg-white"
          placeholder="Describe the app you want to generate..."
          value={value}
          onChange={(event) => setValue(event.target.value)}
          disabled={disabled}
        />
        <button
          type="submit"
          disabled={disabled || value.trim().length < 10}
          className="inline-flex items-center justify-center rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
        >
          {disabled ? "Running..." : "Generate App Spec"}
        </button>
      </form>
    </section>
  );
}
