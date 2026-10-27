// Library catalog: search, paginated results (4 per page), a detail page per
// book. The asked-for book is the 2019 edition of "The Silent Orchard" — it
// sits on results page 2, behind four near-duplicates (the 2011 first
// edition by the same author, a same-title book by someone else, an audio
// edition, a study guide). Success = the final reply carries the right ISBN
// and NOT a decoy's. Exercises search submit, pagination, reading, and
// deciding DONE on a detail page.

import { serve, html, esc, page, type FixtureServer } from "./http.ts";

interface Book {
  id: string;
  title: string;
  author: string;
  year: number;
  format: string;
  isbn: string;
  pages: number;
}

const BOOKS: Book[] = [
  { id: "b1", title: "The Silent Orchard", author: "Mira Holt", year: 2011, format: "Hardcover, first edition", isbn: "978-0-316-48210-3", pages: 344 },
  { id: "b2", title: "The Silent Orchard", author: "Daniel Crane", year: 2019, format: "Paperback", isbn: "978-1-5011-7730-9", pages: 212 },
  { id: "b3", title: "The Silent Orchard (Audiobook)", author: "Mira Holt", year: 2019, format: "Audio CD", isbn: "978-1-9787-0412-6", pages: 0 },
  { id: "b4", title: "Study Guide: The Silent Orchard", author: "Clara Wynn", year: 2020, format: "Paperback", isbn: "978-1-6455-3301-8", pages: 96 },
  { id: "b5", title: "Orchard Road", author: "Mira Holt", year: 2015, format: "Paperback", isbn: "978-0-316-55102-1", pages: 288 },
  { id: "b6", title: "The Silent Orchard", author: "Mira Holt", year: 2019, format: "Paperback, revised edition", isbn: "978-1-4028-9462-7", pages: 362 },
  { id: "b7", title: "Silent Waters", author: "Mira Holt", year: 2021, format: "Hardcover", isbn: "978-0-316-60017-4", pages: 401 },
  { id: "b8", title: "The Orchard Keeper's Daughter", author: "Ines Varga", year: 2018, format: "Paperback", isbn: "978-0-06-285519-2", pages: 310 },
];

export const LOOKUP_ANSWER = "978-1-4028-9462-7";
export const LOOKUP_DECOYS = BOOKS.filter((b) => b.isbn !== LOOKUP_ANSWER).map((b) => b.isbn);

const PER_PAGE = 4;

function search(q: string): Book[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return BOOKS.filter((b) => words.some((w) => `${b.title} ${b.author}`.toLowerCase().includes(w)));
}

const searchForm = (q = "") =>
  `<form action="/search" method="get" role="search" style="display:flex;gap:8px">
<input type="search" name="q" aria-label="Search the catalog" placeholder="Title, author, ISBN" value="${esc(q)}">
<button type="submit">Search</button></form>`;

export async function startLookupFixture(): Promise<FixtureServer> {
  return serve((req, res, url) => {
    if (url.pathname === "/") {
      return html(res, page("Riverside Public Library — Catalog", `<h1>Riverside Public Library</h1><p>Search our catalog of 2 million titles.</p>${searchForm()}`));
    }
    if (url.pathname === "/search") {
      const q = url.searchParams.get("q") ?? "";
      const all = search(q);
      const pageNo = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
      const pages = Math.max(1, Math.ceil(all.length / PER_PAGE));
      const slice = all.slice((pageNo - 1) * PER_PAGE, pageNo * PER_PAGE);
      const items = slice
        .map(
          (b) => `<li style="margin:14px 0"><a href="/book/${b.id}">${esc(b.title)}</a><br>
<span>${esc(b.author)} · ${b.year} · ${esc(b.format)}</span></li>`,
        )
        .join("");
      const nav = [
        pageNo > 1 ? `<a href="/search?q=${encodeURIComponent(q)}&page=${pageNo - 1}">‹ Previous page</a>` : "",
        `<span>Page ${pageNo} of ${pages}</span>`,
        pageNo < pages ? `<a href="/search?q=${encodeURIComponent(q)}&page=${pageNo + 1}">Next page ›</a>` : "",
      ].join(" &nbsp; ");
      return html(
        res,
        page(
          `Search: ${q}`,
          `${searchForm(q)}<h2>${all.length} results for “${esc(q)}”</h2><ol>${items}</ol><nav aria-label="Pagination">${nav}</nav>`,
        ),
      );
    }
    const m = url.pathname.match(/^\/book\/(\w+)$/);
    const book = m && BOOKS.find((b) => b.id === m[1]);
    if (book) {
      return html(
        res,
        page(
          book.title,
          `${searchForm()}<h1>${esc(book.title)}</h1>
<dl>
<dt>Author</dt><dd>${esc(book.author)}</dd>
<dt>Published</dt><dd>${book.year}</dd>
<dt>Format</dt><dd>${esc(book.format)}</dd>
${book.pages ? `<dt>Pages</dt><dd>${book.pages}</dd>` : ""}
<dt>ISBN</dt><dd id="isbn">${book.isbn}</dd>
</dl><p><a href="javascript:history.back()">Back to results</a></p>`,
        ),
      );
    }
    html(res, page("Not found", "<h1>Not found</h1>"), 404);
  });
}
