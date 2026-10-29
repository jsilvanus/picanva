/**
 * Checks if the current app is running embedded in the Canva iframe.
 */
export function isRunningInCanva() {
  try {
    return typeof window !== "undefined" && typeof window.parent !== "undefined" && window.self !== window.top;
  } catch {
    return true; // Cross-origin top indicates iframe embed
  }
}

/**
 * Generates mock slide export blobs for testing outside Canva (or in Node).
 */
function createMockExport() {
  const mockPages = [
    { name: "Slide 1 - Welcome", color: "#1e3a8a", text: "Welcome to Church" },
    { name: "Slide 2 - Song 1", color: "#1e293b", text: "Amazing Grace" },
    { name: "Slide 3 - Sermon", color: "#0f172a", text: "Today's Scripture: John 3:16" },
    { name: "Slide 4 - Blessing", color: "#312e81", text: "Peace Be With You" },
  ];

  const exportBlobs = mockPages.map((p, index) => {
    let url = `https://export.canva.dev/mock/page-${index + 1}.png`;
    if (typeof Blob !== "undefined" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
        <rect width="1920" height="1080" fill="${p.color}"/>
        <text x="960" y="500" font-family="sans-serif" font-size="72" fill="#ffffff" text-anchor="middle" font-weight="bold">${p.text}</text>
        <text x="960" y="600" font-family="sans-serif" font-size="36" fill="#94a3b8" text-anchor="middle">Slide ${index + 1} of ${mockPages.length}</text>
      </svg>`;
      const blob = new Blob([svg], { type: "image/svg+xml" });
      url = URL.createObjectURL(blob);
    }
    return { url, pageNumber: index + 1, name: p.name };
  });

  return {
    status: "completed",
    title: "Sunday Service Presentation (Mock)",
    exportBlobs,
  };
}

/**
 * Requests an uncompressed multi-page export from Canva.
 * Returns { status: 'completed' | 'aborted', title: string, exportBlobs: Array<{ url: string, pageNumber: number }> }
 */
export async function exportDesignPages() {
  if (!isRunningInCanva()) {
    return createMockExport();
  }

  try {
    const { requestExport } = await import("@canva/design");
    const result = await requestExport({
      acceptedFileTypes: [
        {
          type: "png",
          zipped: "never",
        },
      ],
    });

    if (result.status === "aborted") {
      return { status: "aborted", title: "", exportBlobs: [] };
    }

    const blobs = (result.exportBlobs || []).map((blob, idx) => ({
      url: blob.url,
      pageNumber: idx + 1,
      name: `Page ${idx + 1}`,
    }));

    return {
      status: "completed",
      title: result.title || "Canva Presentation",
      exportBlobs: blobs,
    };
  } catch (err) {
    if (err && (err.name === "AbortError" || err.message?.toLowerCase().includes("cancel"))) {
      return { status: "aborted", title: "", exportBlobs: [] };
    }
    console.error("[picanva] Canva requestExport error:", err);
    throw err;
  }
}
