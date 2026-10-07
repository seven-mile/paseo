import { expect, test, type Page, type Request, type Route, type TestInfo } from "playwright/test";
import { writeFileSync } from "node:fs";
import { CATEGORIES } from "../src/plugins/categories";

const hydrationTest = test.extend({ trace: ["on", { scope: "worker" }] });

async function observePluginSearch(page: Page) {
  page.on("console", (message) => {
    if (message.text().startsWith("plugin-search:")) console.info(message.text());
  });
  await page.addInitScript(() => {
    (window as unknown as { __paseoPluginSearchTrace?: boolean }).__paseoPluginSearchTrace = true;
    console.info(
      "plugin-search:document-start",
      performance.now(),
      JSON.stringify({
        browsePath: location.pathname === "/plugins/all",
        hasQuery: Boolean(location.search),
      }),
    );
    for (const method of ["pushState", "replaceState"] as const) {
      const original = history[method];
      history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
        const result = Reflect.apply(original, this, args);
        console.info(
          "plugin-search:history",
          performance.now(),
          method,
          JSON.stringify({
            browsePath: location.pathname === "/plugins/all",
            hasQuery: Boolean(location.search),
            urlIsExpected:
              location.pathname === "/plugins/all" && location.search === "?q=graphite",
          }),
        );
        return result;
      };
    }
    for (const eventName of ["beforeinput", "input", "change"]) {
      document.addEventListener(
        eventName,
        (event) => {
          const target = event.target;
          if (target instanceof HTMLInputElement && target.name === "q") {
            console.info(
              "plugin-search:native",
              performance.now(),
              JSON.stringify({
                event: eventName,
                termIsGraphite: target.value === "graphite",
                termLength: target.value.length,
                nativeTime: event.timeStamp,
                trusted: event.isTrusted,
              }),
            );
          }
        },
        true,
      );
    }
  });
}

function hydrationEvidence(page: Page) {
  const started = performance.now();
  let phase = "root";
  let releasedAtMs: number | undefined;
  let initialQueryReached = false;
  let overflow = false;
  const markers: string[] = [];
  const pageErrors: string[] = [];
  const requests = new Map<
    Request,
    {
      id: number;
      path: string;
      type: string;
      phase: string;
      startedAtMs: number;
      frameIsBrowse: boolean;
      targetReferrer: boolean;
      status?: number;
      responseAtMs?: number;
      heldAtMs?: number;
      failed?: boolean;
    }
  >();
  const declaredScripts = new Set<string>();
  const bodies: Promise<null | void>[] = [];
  const now = () => performance.now() - started;
  page.on("console", (message) => {
    const text = message.text();
    if (text.startsWith("plugin-search:")) {
      if (markers.length < 128 && text.length <= 1024) markers.push(text);
      else overflow = true;
    }
  });
  page.on("pageerror", () => pageErrors.push("pageerror"));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.origin !== "http://127.0.0.1:8187" ||
      !(
        request.isNavigationRequest() ||
        (url.pathname.startsWith("/assets/") && url.pathname.endsWith(".js"))
      )
    )
      return;
    if (requests.size >= 256) {
      overflow = true;
      return;
    }
    const referer = request.headers().referer;
    let targetReferrer = false;
    try {
      const source = new URL(referer);
      targetReferrer =
        source.origin === "http://127.0.0.1:8187" &&
        source.pathname === "/plugins/all" &&
        !source.search;
    } catch {
      /* A missing/ambiguous referrer remains unknown evidence. */
    }
    requests.set(request, {
      id: requests.size + 1,
      path: url.pathname,
      type: request.resourceType(),
      phase,
      startedAtMs: now(),
      targetReferrer,
      frameIsBrowse: new URL(request.frame().url()).pathname === "/plugins/all",
    });
  });
  page.on("requestfailed", (request) => {
    const row = requests.get(request);
    if (row) row.failed = true;
  });
  page.on("response", (response) => {
    const row = requests.get(response.request());
    if (!row) return;
    row.status = response.status();
    row.responseAtMs = now();
    if (row.type === "document" && row.path === "/plugins/all" && row.phase === "target") {
      bodies.push(
        response
          .text()
          .then((html) => {
            if (html.length > 2 * 1024 * 1024) {
              overflow = true;
              return null;
            }
            for (const match of html.matchAll(/(?:src|href)=["']([^"']+\.js)["']/g)) {
              const url = new URL(match[1], response.url());
              if (url.origin === "http://127.0.0.1:8187" && url.pathname.startsWith("/assets/")) {
                if (declaredScripts.size < 256) declaredScripts.add(url.pathname);
                else overflow = true;
              }
            }
            return null;
          })
          .catch(() => {
            pageErrors.push("document-body-unavailable");
          }),
      );
    }
  });
  return {
    target() {
      phase = "target";
    },
    hold(request: Request) {
      const row = requests.get(request);
      if (row) {
        row.heldAtMs = now();
        row.frameIsBrowse = new URL(request.frame().url()).pathname === "/plugins/all";
      }
    },
    release() {
      releasedAtMs ??= now();
    },
    queryReached() {
      initialQueryReached = true;
      phase = "after-initial-query";
    },
    async attach(testInfo: TestInfo) {
      await Promise.all(bodies);
      const output = testInfo.outputPath("plugin-search-evidence.json");
      writeFileSync(
        output,
        JSON.stringify({
          markers,
          pageErrors,
          overflow,
          requests: [...requests.values()],
          declaredScripts: [...declaredScripts],
          releasedAtMs,
          initialQueryReached,
          browserVersion: page.context().browser()?.version(),
          projectName: testInfo.project.name,
          associationLimit:
            "Request/frame/phase is not a document ID; missing target document Referrer remains unknown.",
        }),
      );
      await testInfo.attach("plugin-search-evidence", {
        contentType: "application/json",
        path: output,
      });
    },
  };
}

async function openPlugins(page: Page) {
  await page.goto("/plugins");
  await expect(page.getByRole("heading", { level: 1, name: /^Plugins/ })).toBeVisible();
}

test("browses from the directory into a category, a plugin, and its author", async ({
  page,
  context,
}) => {
  // WebKit has no clipboard permission to grant; record what the page writes instead.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          (window as unknown as { __copied?: string }).__copied = text;
          return Promise.resolve();
        },
      },
    });
  });
  await openPlugins(page);

  await page.getByRole("region", { name: "Categories" }).getByRole("link", { name: /Git/ }).click();
  await expect(page).toHaveURL(/\/plugins\/category\/git$/);
  await expect(page.getByRole("heading", { level: 1, name: /^Git/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Dracula/ })).toHaveCount(0);

  await page.getByRole("link", { name: /Fresh Worktrees/ }).click();
  await expect(page).toHaveURL(/\/plugins\/omercnet\/fresh-worktrees$/);
  await expect(page.getByRole("heading", { name: "Fresh Worktrees" })).toHaveCount(1);
  await expect(page.getByText("paseo plugin install omercnet/fresh-worktrees")).toHaveCount(1);
  await expect(
    page.getByRole("heading", { level: 2, name: "Link to this section Behavior", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Copy to clipboard" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __copied?: string }).__copied))
    .toBe("paseo plugin install omercnet/fresh-worktrees");
  await expect(page.getByRole("link", { name: "Git", exact: true })).toHaveAttribute(
    "href",
    "/plugins/category/git",
  );

  await page.getByRole("link", { name: "Omer Cohen" }).click();
  await expect(page).toHaveURL(/\/plugins\/omercnet$/);
  await expect(page.getByRole("heading", { level: 1, name: "Omer Cohen" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Agent Monitor/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Defer/ })).toHaveCount(0);
});

test("ranks plugins on browse pages by installs in a window or by newest", async ({ page }) => {
  await page.goto("/plugins/all");
  await expect(page.getByRole("heading", { level: 1, name: /^All plugins/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Most installed" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByRole("link", { name: "This month" }).click();
  await expect(page).toHaveURL(/\/plugins\/all\?window=month$/);
  await expect(page.getByRole("link", { name: "This month" })).toHaveAttribute(
    "aria-current",
    "true",
  );

  await page.getByRole("link", { name: "Newest" }).click();
  await expect(page).toHaveURL(/\/plugins\/all\?sort=new$/);
  await expect(page.getByRole("navigation", { name: "Time window" })).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("link", { name: /Base2Tone/ })).toContainText(
    "ago",
  );
});

test("filters by search and clears to all plugins", async ({ page }) => {
  await page.goto("/");
  await openPlugins(page);

  await searchPlugins(page, "graphite");
  await expect(page).toHaveURL(/\/plugins\/all\?q=graphite$/);
  await expect(
    page.getByRole("heading", { level: 1, name: /^Results for “graphite”/ }),
  ).toBeVisible();
  await expect(page.getByRole("main").getByRole("link", { name: /Graphite/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Dracula/ })).toHaveCount(0);

  await searchPlugins(page, "zzzz-nothing");
  await expect(page.getByText("No plugins match.")).toBeVisible();
  await page.getByRole("link", { name: "Clear filters" }).click();
  await expect(page).toHaveURL(/\/plugins\/all$/);
  await expect(page.getByRole("heading", { level: 1, name: /^All plugins/ })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search plugins" })).toHaveValue("");
});

test("keeps the directory's ranking window when searching", async ({ page }) => {
  await page.goto("/plugins?window=month");
  await searchPlugins(page, "graphite");
  await expect(page).toHaveURL(/\/plugins\/all\?q=graphite&window=month$/);
  await expect(page.getByRole("link", { name: "This month" })).toHaveAttribute(
    "aria-current",
    "true",
  );
});

test("clears the search with the clear button", async ({ page }) => {
  if (process.env.CI) await observePluginSearch(page);
  await page.goto("/plugins/all");
  const searchbox = page.getByRole("searchbox", { name: "Search plugins" });
  const clear = page.getByRole("button", { name: "Clear search" });
  await expect(clear).toHaveCount(0);

  await searchPlugins(page, "graphite");
  try {
    await expect(page).toHaveURL(/\/plugins\/all\?q=graphite$/);
  } finally {
    if (process.env.CI) {
      await page
        .evaluate(() => {
          const input = document.querySelector<HTMLInputElement>('input[name="q"]');
          console.info(
            "plugin-search:snapshot",
            performance.now(),
            JSON.stringify({
              urlIsExpected:
                location.pathname === "/plugins/all" && location.search === "?q=graphite",
              browsePath: location.pathname === "/plugins/all",
              hasQuery: Boolean(location.search),
              inputIsGraphite: input?.value === "graphite",
              inputLength: input?.value.length,
              clearPresent: Boolean(document.querySelector('[aria-label="Clear search"]')),
            }),
          );
        })
        .catch(() => console.info("plugin-search:snapshot-unavailable"));
    }
  }
  await clear.click();
  await expect(page).toHaveURL(/\/plugins\/all$/);
  await expect(searchbox).toHaveValue("");
  await expect(searchbox).toBeFocused();
  await expect(clear).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: /^All plugins/ })).toBeVisible();
});

test("replaces history while typing a search", async ({ page }) => {
  if (process.env.CI) await observePluginSearch(page);
  await page.goto("/");
  await page.goto("/plugins/all");
  await searchPlugins(page, "graphite");
  try {
    await expect(page).toHaveURL(/\/plugins\/all\?q=graphite$/);
  } finally {
    if (process.env.CI) {
      await page
        .evaluate(() => {
          const input = document.querySelector<HTMLInputElement>('input[name="q"]');
          console.info(
            "plugin-search:snapshot",
            performance.now(),
            JSON.stringify({
              urlIsExpected:
                location.pathname === "/plugins/all" && location.search === "?q=graphite",
              browsePath: location.pathname === "/plugins/all",
              hasQuery: Boolean(location.search),
              inputIsGraphite: input?.value === "graphite",
              inputLength: input?.value.length,
              clearPresent: Boolean(document.querySelector('[aria-label="Clear search"]')),
            }),
          );
        })
        .catch(() => console.info("plugin-search:snapshot-unavailable"));
    }
  }
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
});

test.describe("early search input", () => {
  hydrationTest("preserves search typed before hydration", async ({ page }, testInfo) => {
    const evidence = hydrationEvidence(page);
    if (process.env.CI) await observePluginSearch(page);
    await page.goto("/");
    const origin = new URL(page.url()).origin;
    let releaseScripts!: () => void;
    const scripts = new Promise<void>((resolve) => {
      releaseScripts = resolve;
    });
    let heldScripts = 0;
    const assets = (url: URL) =>
      url.origin === origin && url.pathname.startsWith("/assets/") && url.pathname.endsWith(".js");
    await page.route(assets, async (route: Route) => {
      heldScripts++;
      evidence.hold(route.request());
      await scripts;
      await route.continue();
    });
    try {
      evidence.target();
      await page.goto("/plugins/all", { waitUntil: "commit" });
      const searchbox = page.getByRole("searchbox", { name: "Search plugins" });
      const clear = page.getByRole("button", { name: "Clear search" });
      await expect(clear).toHaveCount(0);
      await searchPlugins(page, "graphite");
      expect(heldScripts).toBeGreaterThan(0);
      await expect(searchbox).toHaveValue("graphite");
      evidence.release();
      releaseScripts();
      // Initial pre-hydration query assertion.
      await expect(page).toHaveURL(/\/plugins\/all\?q=graphite$/);
      evidence.queryReached();
      await expect(
        page.getByRole("heading", { level: 1, name: /^Results for “graphite”/ }),
      ).toBeVisible();
      await expect(page.getByRole("main").getByRole("link", { name: /Graphite/ })).toBeVisible();
      await expect(page.getByRole("link", { name: /Dracula/ })).toHaveCount(0);
      await clear.click();
      await expect(page).toHaveURL(/\/plugins\/all$/);
      await expect(searchbox).toHaveValue("");
      await expect(searchbox).toBeFocused();
      await expect(clear).toHaveCount(0);
      await expect(page.getByRole("heading", { level: 1, name: /^All plugins/ })).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(/\/$/);
    } finally {
      releaseScripts();
      await page.unrouteAll({ behavior: "wait" });
      await evidence.attach(testInfo);
    }
  });
});

test("keeps old category links working", async ({ page }) => {
  await page.goto("/plugins?category=git&sort=new");
  await expect(page).toHaveURL(/\/plugins\/category\/git\?sort=new$/);
  await expect(page.getByRole("heading", { level: 1, name: /^Git/ })).toBeVisible();
});

test("explains a plugin that is not listed", async ({ page }) => {
  await page.goto("/plugins/acme/does-not-exist");
  await expect(page.getByRole("heading", { level: 1, name: "Plugin not found" })).toBeVisible();
  await page.getByRole("link", { name: "Browse all plugins" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /^Plugins/ })).toBeVisible();
});

test.describe("search engine visits without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("reads directory, category, author, and complete plugin HTML with page metadata", async ({
    page,
  }) => {
    await openPlugins(page);
    await expect(page.getByRole("link", { name: /Base2Tone/ }).first()).toBeVisible();
    await expectPageMetadata(page, "Plugins – Extend Paseo with community plugins", "/plugins");

    await page.goto("/plugins/category/git");
    await expect(page.getByRole("link", { name: /Fresh Worktrees/ })).toBeVisible();
    await expectPageMetadata(page, "Git – Paseo plugins", "/plugins/category/git");

    await page.goto("/plugins/omercnet");
    await expect(page.getByRole("heading", { level: 1, name: "Omer Cohen" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Fresh Worktrees/ }).first()).toBeVisible();
    await expectPageMetadata(page, "Omer Cohen – Paseo plugins", "/plugins/omercnet");

    const response = await page.goto("/plugins/omercnet/fresh-worktrees");
    expect(response?.status()).toBe(200);
    expect(response?.headers()["cache-control"]).toBe("private, no-store");
    expect(response?.headers()["x-robots-tag"]).toBeUndefined();
    await expect(page.getByText("paseo plugin install omercnet/fresh-worktrees")).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 2, name: "Link to this section Behavior", exact: true }),
    ).toBeVisible();
    await expectPageMetadata(
      page,
      "Fresh Worktrees – Paseo plugin",
      "/plugins/omercnet/fresh-worktrees",
    );
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      "content",
      "https://raw.githubusercontent.com/omercnet/paseo-plugins/main/fresh-worktrees/docs/images/fresh-worktrees-behind.png",
    );
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      "Fast-forwards clean local base branches before Paseo creates branch-off worktrees",
    );
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0);

    await page.goto("/plugins/tomgrin10/graphite");
    await expectPageMetadata(page, "Graphite – Paseo plugin", "/plugins/tomgrin10/graphite");
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      "content",
      "https://paseo.sh/og-image.png",
    );
  });

  test("renders search results and submits the search form", async ({ page }) => {
    await page.goto("/plugins/all?q=graphite");
    await expect(
      page.getByRole("heading", { level: 1, name: /^Results for “graphite”/ }),
    ).toBeVisible();
    await expect(page.getByRole("main").getByRole("link", { name: /Graphite/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Dracula/ })).toHaveCount(0);

    await page.goto("/plugins/category/git");
    await searchPlugins(page, "fresh");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/plugins\/category\/git\?q=fresh$/);
    await expect(
      page.getByRole("heading", { level: 1, name: /^Results for “fresh” in Git/ }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /Fresh Worktrees/ })).toBeVisible();
    await page.getByRole("link", { name: "Clear", exact: true }).click();
    await expect(page).toHaveURL(/\/plugins\/category\/git$/);
  });

  test("returns real 404 pages for unknown plugins, authors, and categories", async ({ page }) => {
    const plugin = await page.goto("/plugins/acme/does-not-exist");
    expect(plugin?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Plugin not found" })).toBeVisible();
    await expect(page).toHaveTitle("Plugin not found – Paseo");
    const author = await page.goto("/plugins/does-not-exist");
    expect(author?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Author not found" })).toBeVisible();
    await expect(page).toHaveTitle("Author not found – Paseo");
    const category = await page.goto("/plugins/category/does-not-exist");
    expect(category?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Category not found" })).toBeVisible();
    await expect(page).toHaveTitle("Category not found – Paseo");
  });

  test("redirects old category links permanently", async ({ request }) => {
    const response = await request.get("/plugins?category=git", { maxRedirects: 0 });
    expect(response.status()).toBe(301);
    expect(response.headers().location).toMatch(/\/plugins\/category\/git$/);
    const search = await request.get("/plugins?q=graphite", { maxRedirects: 0 });
    expect(search.status()).toBe(301);
    expect(search.headers().location).toMatch(/\/plugins\/all\?q=graphite$/);
    const windowed = await request.get("/plugins?q=graphite&window=month", { maxRedirects: 0 });
    expect(windowed.headers().location).toMatch(/\/plugins\/all\?q=graphite&window=month$/);
  });

  test("discovers plugin, category, and author URLs through robots and the sitemap index", async ({
    request,
  }) => {
    const robots = await request.get("/robots.txt");
    expect(await robots.text()).toContain("Sitemap: https://paseo.sh/sitemap-index.xml");
    const index = await request.get("/sitemap-index.xml");
    expect(await index.text()).toContain("https://paseo.sh/sitemap-plugins.xml");
    const plugins = await request.get("/sitemap-plugins.xml");
    expect(plugins.status()).toBe(200);
    expect(plugins.headers()["content-type"]).toContain("application/xml");
    const sitemap = await plugins.text();
    expect(sitemap).toContain("<loc>https://paseo.sh/plugins/all</loc>");
    expect(sitemap).toContain("<loc>https://paseo.sh/plugins/category/git</loc>");
    expect(sitemap).toContain("<loc>https://paseo.sh/plugins/omercnet</loc>");
    expect(sitemap).toContain("<loc>https://paseo.sh/plugins/omercnet/fresh-worktrees</loc>");
  });
});

async function searchPlugins(page: Page, term: string) {
  await page.getByRole("searchbox", { name: "Search plugins" }).fill(term);
}

async function expectPageMetadata(page: Page, title: string, path: string) {
  await expect(page).toHaveTitle(title);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    `https://paseo.sh${path}`,
  );
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", title);
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
    "content",
    `https://paseo.sh${path}`,
  );
  await expect(page.locator('meta[property="og:type"]')).toHaveAttribute("content", "website");
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
    "content",
    "summary_large_image",
  );
  const description = await page.locator('meta[name="description"]').getAttribute("content");
  expect(description).toBeTruthy();
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute(
    "content",
    description!,
  );
}

test("keeps the directory unlinked until the coordinated announcement", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("banner").getByRole("link", { name: "Plugins", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("contentinfo").getByRole("link", { name: "Plugins", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Community plugins" })).toHaveAttribute(
    "href",
    "https://paseo.cafe",
  );
  await expect(page.locator('a[href="/plugins"]')).toHaveCount(0);
  const response = await page.goto("/plugins");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: /^Plugins/ })).toBeVisible();
});

// External deployments own their registry contents; these assertions use the local fixture.
test.describe("registry fixture layout", () => {
  test.skip(Boolean(process.env.WEBSITE_TEST_URL), "Requires the local registry fixture");

  test("lists the nine categories in order with counts, and the newest plugins first", async ({
    page,
  }) => {
    await openPlugins(page);
    const categories = page.getByRole("region", { name: "Categories" });
    await expect(categories.getByRole("link")).toHaveText(
      CATEGORIES.map((category) => new RegExp(`^${category.label}\\s*\\d+$`)),
    );
    await expect(categories.getByRole("link", { name: /Extras/ })).toContainText("0");
    await expect(
      page.getByRole("region", { name: "What’s new" }).getByRole("link", { name: /Added/ }),
    ).toHaveText([/Base2Tone/, /Sayr/, /PromptKit/, /Defer/]);
  });
});
