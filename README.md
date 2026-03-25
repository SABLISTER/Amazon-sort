# Amazon Delivery Sorter

Chrome extension prototype that reorders Amazon.com search result cards by the earliest delivery estimate visible on the page and lets you inspect 1-star reviews inline without leaving search results.

## What It Does

- Sorts currently loaded Amazon search results by the delivery text already rendered in each result card.
- Supports manual sorting from either the page toolbar or the extension popup.
- Can auto-sort again when Amazon loads more results into the page.
- Keeps results with unknown or missing delivery estimates at the bottom.
- Lets you restore the original page order for the results that were already loaded.
- Adds a `1-star reviews` chip to each result card and loads Amazon's first page of 1-star reviews into the floating toolbar.
- Includes an opt-in popup checkbox to automatically show the same 1-star review panel on Amazon product detail pages.

## Why This Approach

Amazon does not expose a stable public search API for this use case, so this version works entirely in the page after results render. That keeps the extension self-contained and avoids credentials, scraping proxies, or API maintenance.

## Load The Extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `/Volumes/MacbackPro/CODING/Archive/amazon-delivery-sorter`.
5. Open an `amazon.com` search results page such as `https://www.amazon.com/s?k=headphones`.

## Usage

- Use the floating **Delivery Sort** toolbar on the Amazon results page to sort `Soonest`, `Latest`, or `Restore`.
- Click a result card's `1-star reviews` chip to expand the toolbar and scroll through the first Amazon page of that product's 1-star reviews.
- Turn on **Show the 1-star review panel on Amazon product pages** in the popup if you want that same panel to auto-appear on `/dp/...` product pages.
- Use the popup to change the default direction and toggle **Auto-sort when new results load**.
- Unknown delivery estimates stay last because there is no reliable date to compare.

## Run Tests

```bash
cd /Volumes/MacbackPro/CODING/Archive/amazon-delivery-sorter
npm test
```

## Current Limits

- It only sorts results already loaded into the DOM. If Amazon changes the results markup, selectors or parsing rules may need updates.
- The parser uses delivery text heuristics, so ambiguous cards can still end up in the unknown bucket.
- The review panel relies on Amazon's signed-in review HTML. If Amazon serves a bot check or sign-in page instead, open the full review page once and retry.
- The manifest currently targets `amazon.com`. Add more Amazon host patterns if you need other storefronts.
