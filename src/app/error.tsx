"use client";

import { useEffect } from "react";

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl rounded-3xl border border-rose-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold text-rose-900">Application error</h1>
        <p className="mt-4 text-slate-700">Something went wrong while loading the page.</p>
        <pre className="mt-4 overflow-x-auto rounded-xl bg-slate-950 p-4 text-sm text-white">
          {String(error.message)}
        </pre>
        <button
          type="button"
          onClick={reset}
          className="mt-6 inline-flex rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
