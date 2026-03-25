(function () {
  "use strict";

  if (window.__amazonDeliverySorterLoaded) {
    return;
  }

  window.__amazonDeliverySorterLoaded = true;

  const DEFAULT_SETTINGS = {
    autoSort: true,
    sortDirection: "asc",
    showProductPageReviews: false
  };
  const RESULT_SELECTOR = '[data-component-type="s-search-result"]';
  const TOOLBAR_ID = "amazon-delivery-sorter-toolbar";
  const STYLE_ID = "amazon-delivery-sorter-style";
  const ORIGINAL_INDEX_KEY = "amazonDeliverySorterOriginalIndex";
  const REVIEW_TRIGGER_SELECTOR = "[data-amazon-delivery-sorter-review-trigger]";

  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let observer = null;
  let sortTimer = null;
  let applyingSort = false;
  let currentOrder = "original";
  let activeReviewAsin = null;
  let activeReviewRequestId = 0;

  const reviewCache = new Map();

  function isSearchPage() {
    return window.location.pathname === "/s";
  }

  function extractAsinFromPath(pathname) {
    const match = String(pathname || "").match(/^\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i);
    return match ? String(match[1]).toUpperCase() : "";
  }

  function isProductPage() {
    return Boolean(extractAsinFromPath(window.location.pathname));
  }

  function isSupportedPage() {
    return isSearchPage() || isProductPage();
  }

  function normalizeText(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function toPromise(callbackBasedApi) {
    return new Promise(function (resolve) {
      callbackBasedApi(resolve);
    });
  }

  function loadSettings() {
    return toPromise(function (resolve) {
      chrome.storage.sync.get(DEFAULT_SETTINGS, resolve);
    }).then(function (stored) {
      settings = Object.assign({}, DEFAULT_SETTINGS, stored || {});
      return settings;
    });
  }

  function saveSettings(nextSettings) {
    settings = Object.assign({}, settings, nextSettings);
    return toPromise(function (resolve) {
      chrome.storage.sync.set(nextSettings, resolve);
    });
  }

  function getResultContainer() {
    const firstResult = document.querySelector(RESULT_SELECTOR);
    return firstResult ? firstResult.parentElement : null;
  }

  function getResultNodes() {
    const container = getResultContainer();
    if (!container) {
      return [];
    }

    return Array.from(container.children).filter(function (node) {
      return node.matches && node.matches(RESULT_SELECTOR);
    });
  }

  function ensureOriginalIndexes() {
    const resultNodes = getResultNodes();
    let nextIndex = resultNodes.reduce(function (highest, node) {
      const current = Number(node.dataset[ORIGINAL_INDEX_KEY]);
      return Number.isFinite(current) ? Math.max(highest, current) : highest;
    }, -1) + 1;

    resultNodes.forEach(function (node) {
      if (!node.dataset[ORIGINAL_INDEX_KEY]) {
        node.dataset[ORIGINAL_INDEX_KEY] = String(nextIndex);
        nextIndex += 1;
      }
    });
  }

  function collectResults() {
    ensureOriginalIndexes();

    return getResultNodes().map(function (node) {
      const text = node.innerText || node.textContent || "";
      const estimate = window.AmazonDeliverySorterParser.parseDeliveryEstimate(text, new Date());

      return {
        element: node,
        originalIndex: Number(node.dataset[ORIGINAL_INDEX_KEY]) || 0,
        estimate: estimate
      };
    });
  }

  function compareResults(left, right, direction) {
    const leftKnown = left.estimate.isKnown;
    const rightKnown = right.estimate.isKnown;

    if (leftKnown !== rightKnown) {
      return leftKnown ? -1 : 1;
    }

    if (leftKnown && rightKnown && left.estimate.timestamp !== right.estimate.timestamp) {
      return direction === "desc"
        ? right.estimate.timestamp - left.estimate.timestamp
        : left.estimate.timestamp - right.estimate.timestamp;
    }

    return left.originalIndex - right.originalIndex;
  }

  function replaceResultsInPlace(container, orderedNodes) {
    const currentNodes = getResultNodes();

    if (!container || !currentNodes.length || currentNodes.length !== orderedNodes.length) {
      return false;
    }

    const markers = currentNodes.map(function (node) {
      const marker = document.createComment("amazon-delivery-sorter-slot");
      container.replaceChild(marker, node);
      return marker;
    });

    orderedNodes.forEach(function (node, index) {
      container.insertBefore(node, markers[index]);
      markers[index].remove();
    });

    return true;
  }

  function formatEstimate(estimate) {
    if (!estimate || !(estimate.date instanceof Date)) {
      return "Unknown";
    }

    const lowerMatch = String(estimate.matchedText || "").toLowerCase();
    const dateLabel = estimate.date.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric"
    });

    const hourMatch = lowerMatch.match(/\b(?:in|within)\s+(\d{1,2})\s*(hour|hours|hr|hrs)\b/);
    if (hourMatch) {
      return "Today (in " + hourMatch[1] + " hours)";
    }

    if (/\b(today|same[- ]day)\b/.test(lowerMatch)) {
      return "Today";
    }

    if (/\bovernight\b/.test(lowerMatch)) {
      return "Overnight";
    }

    return dateLabel;
  }

  function findReviewLink(resultNode) {
    if (!resultNode) {
      return null;
    }

    return (
      resultNode.querySelector('a[href*="#customerReviews"]') ||
      resultNode.querySelector('a[href*="customerReviews"]') ||
      resultNode.querySelector('a[href*="/product-reviews/"]')
    );
  }

  function getProductTitle(resultNode) {
    if (!resultNode) {
      return "";
    }

    const titleNode =
      resultNode.querySelector("h2 span") ||
      resultNode.querySelector("h2") ||
      resultNode.querySelector('[data-cy="title-recipe"] h2 span');

    return normalizeText(titleNode ? titleNode.textContent : "");
  }

  function getProductRatingLabel(resultNode) {
    if (!resultNode) {
      return "";
    }

    const ratingNode = resultNode.querySelector('[aria-label*="out of 5 stars"]');
    return normalizeText(
      ratingNode ? ratingNode.getAttribute("aria-label") || ratingNode.textContent : ""
    );
  }

  function getProductInfo(resultNode) {
    return {
      asin: normalizeText(resultNode && resultNode.getAttribute("data-asin")),
      title: getProductTitle(resultNode),
      ratingLabel: getProductRatingLabel(resultNode),
      reviewCountLabel: ""
    };
  }

  function getProductPageInfo() {
    let asin = "";
    const asinField = document.getElementById("ASIN");
    if (asinField && asinField.value) {
      asin = normalizeText(asinField.value).toUpperCase();
    }

    if (!asin) {
      asin = extractAsinFromPath(window.location.pathname);
    }

    if (!asin) {
      const asinNode = document.querySelector("[data-asin]");
      asin = normalizeText(asinNode && asinNode.getAttribute("data-asin")).toUpperCase();
    }

    if (!/^[A-Z0-9]{10}$/.test(asin)) {
      return null;
    }

    const titleNode = document.getElementById("productTitle");
    const ratingNode = document.getElementById("acrPopover");
    const reviewCountNode = document.getElementById("acrCustomerReviewText");
    const fallbackRatingNode = document.querySelector('[data-hook="rating-out-of-text"]');

    return {
      asin: asin,
      title: normalizeText(titleNode ? titleNode.textContent : ""),
      ratingLabel: normalizeText(
        ratingNode
          ? ratingNode.getAttribute("title") || ratingNode.textContent
          : fallbackRatingNode
            ? fallbackRatingNode.textContent
            : ""
      ),
      reviewCountLabel: normalizeText(reviewCountNode ? reviewCountNode.textContent : "")
    };
  }

  function updateToolbarStatus(message, type) {
    const statusNode = document.querySelector("#amazon-delivery-sorter-status");
    if (!statusNode) {
      return;
    }

    statusNode.textContent = message;
    statusNode.dataset.state = type || "info";
  }

  function syncToolbarControls() {
    const autoSortNode = document.querySelector("#amazon-delivery-sorter-auto-sort");
    const ascButton = document.querySelector("#amazon-delivery-sorter-asc");
    const descButton = document.querySelector("#amazon-delivery-sorter-desc");

    if (autoSortNode) {
      autoSortNode.checked = settings.autoSort;
    }

    if (ascButton) {
      ascButton.dataset.active = currentOrder === "asc" ? "true" : "false";
    }

    if (descButton) {
      descButton.dataset.active = currentOrder === "desc" ? "true" : "false";
    }
  }

  function syncReviewButtons() {
    document.querySelectorAll(REVIEW_TRIGGER_SELECTOR).forEach(function (button) {
      const isActive = button.dataset.asin === activeReviewAsin;
      button.dataset.active = isActive ? "true" : "false";
      button.textContent = isActive ? "Viewing 1-star reviews" : "1-star reviews";
    });
  }

  function applySort(direction, source) {
    const container = getResultContainer();
    if (!container) {
      updateToolbarStatus("Waiting for Amazon results to appear.", "info");
      return {
        ok: false,
        reason: "no-results"
      };
    }

    const results = collectResults();
    if (!results.length) {
      updateToolbarStatus("No sortable search results found on this page.", "warning");
      return {
        ok: false,
        reason: "no-results"
      };
    }

    const sorted = results.slice().sort(function (left, right) {
      return compareResults(left, right, direction);
    });

    applyingSort = true;
    const changed = replaceResultsInPlace(
      container,
      sorted.map(function (entry) {
        return entry.element;
      })
    );
    applyingSort = false;

    if (!changed) {
      updateToolbarStatus("Unable to reorder the current results layout.", "warning");
      return {
        ok: false,
        reason: "layout-changed"
      };
    }

    currentOrder = direction;
    syncToolbarControls();

    const known = sorted.filter(function (entry) {
      return entry.estimate.isKnown;
    });
    const firstKnown = known[0];
    const sourceLabel = source === "auto" ? "Auto-sorted" : "Sorted";
    const edgeLabel = direction === "desc" ? "Latest" : "Earliest";
    const summary = known.length
      ? sourceLabel +
        " " +
        results.length +
        " results. " +
        edgeLabel +
        " known delivery: " +
        formatEstimate(firstKnown.estimate) +
        "."
      : sourceLabel + " " + results.length + " results. Unknown delivery estimates stayed last.";

    updateToolbarStatus(summary, "success");

    return {
      ok: true,
      summary: summary,
      knownCount: known.length,
      totalCount: results.length,
      currentOrder: currentOrder
    };
  }

  function restoreOriginalOrder() {
    const container = getResultContainer();
    const results = collectResults();

    if (!container || !results.length) {
      updateToolbarStatus("Nothing to restore on this page.", "info");
      return {
        ok: false
      };
    }

    const originalOrder = results.slice().sort(function (left, right) {
      return left.originalIndex - right.originalIndex;
    });

    applyingSort = true;
    const changed = replaceResultsInPlace(
      container,
      originalOrder.map(function (entry) {
        return entry.element;
      })
    );
    applyingSort = false;

    if (!changed) {
      updateToolbarStatus("Unable to restore the original result order.", "warning");
      return {
        ok: false
      };
    }

    currentOrder = "original";
    syncToolbarControls();
    updateToolbarStatus("Restored the loaded results to their original page order.", "success");

    return {
      ok: true,
      currentOrder: currentOrder
    };
  }

  function scheduleAutoSort() {
    if (!settings.autoSort || !isSearchPage()) {
      return;
    }

    window.clearTimeout(sortTimer);
    sortTimer = window.setTimeout(function () {
      applySort(settings.sortDirection, "auto");
    }, 300);
  }

  function insertAfter(referenceNode, nodeToInsert) {
    if (!referenceNode || !referenceNode.parentNode) {
      return false;
    }

    referenceNode.parentNode.insertBefore(nodeToInsert, referenceNode.nextSibling);
    return true;
  }

  function getReviewButtonMount(resultNode) {
    const reviewLink = findReviewLink(resultNode);
    if (reviewLink && reviewLink.parentElement) {
      return {
        referenceNode: reviewLink.parentElement,
        mode: "inline"
      };
    }

    const titleAnchor = resultNode.querySelector("h2") && resultNode.querySelector("h2").parentElement;
    if (titleAnchor) {
      return {
        referenceNode: titleAnchor,
        mode: "block"
      };
    }

    const titleNode = resultNode.querySelector("h2");
    if (titleNode) {
      return {
        referenceNode: titleNode,
        mode: "block"
      };
    }

    return null;
  }

  function buildOneStarReviewUrl(asin) {
    return new URL(
      "/product-reviews/" +
        encodeURIComponent(asin) +
        "/?reviewerType=all_reviews&filterByStar=one_star",
      window.location.origin
    ).toString();
  }

  function getReviewPanelNodes() {
    return {
      toolbar: document.getElementById(TOOLBAR_ID),
      titleBar: document.getElementById("amazon-delivery-sorter-toolbar-title"),
      panel: document.getElementById("amazon-delivery-sorter-review-panel"),
      title: document.getElementById("amazon-delivery-sorter-review-title"),
      meta: document.getElementById("amazon-delivery-sorter-review-meta"),
      link: document.getElementById("amazon-delivery-sorter-review-link"),
      feedback: document.getElementById("amazon-delivery-sorter-review-feedback"),
      list: document.getElementById("amazon-delivery-sorter-review-list")
    };
  }

  function setReviewPanelVisibility(isVisible) {
    const nodes = getReviewPanelNodes();
    if (!nodes.panel || !nodes.toolbar) {
      return;
    }

    nodes.panel.hidden = !isVisible;
    nodes.toolbar.dataset.expanded = isVisible ? "true" : "false";
  }

  function setReviewPanelFeedback(message, state) {
    const feedback = document.getElementById("amazon-delivery-sorter-review-feedback");
    if (!feedback) {
      return;
    }

    feedback.textContent = message;
    feedback.dataset.state = state || "info";
  }

  function clearReviewPanel() {
    activeReviewAsin = null;
    activeReviewRequestId += 1;
    setReviewPanelVisibility(false);
    syncReviewButtons();
  }

  function getToolbarPageMeta(productInfo, reviewData) {
    return [productInfo.ratingLabel, productInfo.reviewCountLabel, reviewData && reviewData.filterInfo]
      .filter(Boolean)
      .join(" | ");
  }

  function createReviewCard(review) {
    const article = document.createElement("article");
    article.className = "amazon-delivery-sorter__review-card";

    const heading = document.createElement("div");
    heading.className = "amazon-delivery-sorter__review-card-heading";

    const title = document.createElement("div");
    title.className = "amazon-delivery-sorter__review-card-title";
    title.textContent = review.title || review.rating || "1-star review";
    heading.appendChild(title);

    if (review.rating) {
      const rating = document.createElement("div");
      rating.className = "amazon-delivery-sorter__review-card-rating";
      rating.textContent = review.rating;
      heading.appendChild(rating);
    }

    article.appendChild(heading);

    const metaParts = [review.author, review.date, review.format].filter(Boolean);
    if (metaParts.length) {
      const meta = document.createElement("div");
      meta.className = "amazon-delivery-sorter__review-card-meta";
      meta.textContent = metaParts.join(" | ");
      article.appendChild(meta);
    }

    if (review.body) {
      const body = document.createElement("div");
      body.className = "amazon-delivery-sorter__review-card-body";
      body.textContent = review.body;
      article.appendChild(body);
    }

    if (review.helpful) {
      const helpful = document.createElement("div");
      helpful.className = "amazon-delivery-sorter__review-card-helpful";
      helpful.textContent = review.helpful;
      article.appendChild(helpful);
    }

    return article;
  }

  function getNodeText(node) {
    return normalizeText(node ? node.textContent : "");
  }

  function cleanReviewTitle(rawTitle, rating) {
    let title = normalizeText(rawTitle);
    const ratingLabel = normalizeText(rating);

    if (ratingLabel && title.toLowerCase().indexOf(ratingLabel.toLowerCase()) === 0) {
      title = title.slice(ratingLabel.length).trim();
    }

    return title.replace(/^[-:|]\s*/, "");
  }

  function extractReviewFromNode(reviewNode) {
    const rating = getNodeText(
      reviewNode.querySelector('[data-hook="review-star-rating"], [data-hook="cmps-review-star-rating"]')
    );
    const rawTitle = getNodeText(reviewNode.querySelector('[data-hook="review-title"]'));
    const body = getNodeText(reviewNode.querySelector('[data-hook="review-body"]'));
    const author = getNodeText(reviewNode.querySelector(".a-profile-name"));
    const date = getNodeText(reviewNode.querySelector('[data-hook="review-date"]'));
    const format = getNodeText(reviewNode.querySelector('[data-hook="format-strip"]'));
    const helpful = getNodeText(reviewNode.querySelector('[data-hook="helpful-vote-statement"]'));

    return {
      rating: rating,
      title: cleanReviewTitle(rawTitle, rating),
      body: body,
      author: author,
      date: date,
      format: format,
      helpful: helpful
    };
  }

  function parseReviewPage(html, fallbackUrl) {
    const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
    const pageTitle = normalizeText(doc.title);

    if (
      /robot check/i.test(pageTitle) ||
      doc.querySelector('form[action*="validateCaptcha"]') ||
      doc.querySelector('form[action*="/errors/validateCaptcha"]')
    ) {
      return {
        error: "Amazon asked for a bot check. Open the full review page once, then try again."
      };
    }

    if (/sign in/i.test(pageTitle) || doc.querySelector('form[action*="/ap/signin"]')) {
      return {
        error: "Amazon returned a sign-in page instead of 1-star reviews."
      };
    }

    const reviews = Array.from(doc.querySelectorAll('[data-hook="review"]'))
      .map(extractReviewFromNode)
      .filter(function (review) {
        return review.title || review.body;
      });

    const filterInfo = getNodeText(
      doc.querySelector('[data-hook="cr-filter-info-review-rating-count"]')
    );

    return {
      reviews: reviews,
      filterInfo: filterInfo,
      reviewPageUrl: fallbackUrl
    };
  }

  function renderReviewPanel(productInfo, reviewData) {
    const nodes = getReviewPanelNodes();
    if (!nodes.panel || !nodes.title || !nodes.meta || !nodes.link || !nodes.list) {
      return;
    }

    setReviewPanelVisibility(true);

    nodes.title.textContent = productInfo.title || ("ASIN " + productInfo.asin);
    nodes.meta.textContent = getToolbarPageMeta(productInfo, reviewData);
    nodes.link.href = reviewData.reviewPageUrl;
    nodes.link.hidden = false;
    nodes.list.innerHTML = "";

    if (reviewData.reviews.length) {
      reviewData.reviews.forEach(function (review) {
        nodes.list.appendChild(createReviewCard(review));
      });
      setReviewPanelFeedback(
        "Showing the first Amazon page of 1-star reviews in a scrollable list.",
        "success"
      );
      return;
    }

    setReviewPanelFeedback("Amazon did not return any 1-star reviews for this product.", "warning");
  }

  function renderReviewPanelLoading(productInfo, reviewUrl) {
    const nodes = getReviewPanelNodes();
    if (!nodes.panel || !nodes.title || !nodes.meta || !nodes.link || !nodes.list) {
      return;
    }

    setReviewPanelVisibility(true);

    nodes.title.textContent = productInfo.title || ("ASIN " + productInfo.asin);
    nodes.meta.textContent = getToolbarPageMeta(productInfo) || "Loading Amazon 1-star reviews";
    nodes.link.href = reviewUrl;
    nodes.link.hidden = false;
    nodes.list.innerHTML = "";
    setReviewPanelFeedback("Loading Amazon 1-star reviews for this result...", "info");
  }

  function renderReviewPanelError(productInfo, reviewUrl, message) {
    const nodes = getReviewPanelNodes();
    if (!nodes.panel || !nodes.title || !nodes.meta || !nodes.link || !nodes.list) {
      return;
    }

    setReviewPanelVisibility(true);

    nodes.title.textContent = productInfo.title || ("ASIN " + productInfo.asin);
    nodes.meta.textContent = getToolbarPageMeta(productInfo);
    nodes.link.href = reviewUrl;
    nodes.link.hidden = false;
    nodes.list.innerHTML = "";
    setReviewPanelFeedback(message, "warning");
  }

  function openReviewsForProductInfo(productInfo) {
    if (!productInfo.asin) {
      updateToolbarStatus("This result does not expose a product ASIN for reviews.", "warning");
      return;
    }

    const reviewUrl = buildOneStarReviewUrl(productInfo.asin);
    const cached = reviewCache.get(productInfo.asin);

    activeReviewAsin = productInfo.asin;
    syncReviewButtons();

    if (cached) {
      renderReviewPanel(productInfo, cached);
      return;
    }

    renderReviewPanelLoading(productInfo, reviewUrl);

    const requestId = activeReviewRequestId + 1;
    activeReviewRequestId = requestId;

    fetch(reviewUrl, {
      credentials: "include"
    })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("Amazon returned " + response.status + " while loading reviews.");
        }

        return response.text();
      })
      .then(function (html) {
        if (requestId !== activeReviewRequestId || activeReviewAsin !== productInfo.asin) {
          return;
        }

        const parsed = parseReviewPage(html, reviewUrl);
        if (parsed.error) {
          throw new Error(parsed.error);
        }

        reviewCache.set(productInfo.asin, parsed);
        renderReviewPanel(productInfo, parsed);
      })
      .catch(function (error) {
        if (requestId !== activeReviewRequestId || activeReviewAsin !== productInfo.asin) {
          return;
        }

        renderReviewPanelError(
          productInfo,
          reviewUrl,
          normalizeText(error && error.message) || "Amazon did not return readable 1-star reviews."
        );
      });
  }

  function openReviewsForResult(resultNode) {
    openReviewsForProductInfo(getProductInfo(resultNode));
  }

  function syncToolbarMode() {
    const nodes = getReviewPanelNodes();
    if (!nodes.toolbar || !nodes.titleBar) {
      return;
    }

    if (isProductPage()) {
      nodes.toolbar.dataset.pageType = "product";
      nodes.titleBar.textContent = "Amazon Reviews";
      nodes.toolbar.hidden = !settings.showProductPageReviews;

      if (!settings.showProductPageReviews) {
        clearReviewPanel();
        return;
      }

      const productInfo = getProductPageInfo();
      if (!productInfo) {
        return;
      }

      if (activeReviewAsin !== productInfo.asin || nodes.panel.hidden) {
        openReviewsForProductInfo(productInfo);
      } else {
        setReviewPanelVisibility(true);
      }

      return;
    }

    nodes.toolbar.hidden = false;
    nodes.toolbar.dataset.pageType = "search";
    nodes.titleBar.textContent = "Delivery Sort";
  }

  function ensureReviewButtons() {
    getResultNodes().forEach(function (resultNode) {
      const productInfo = getProductInfo(resultNode);
      if (!productInfo.asin) {
        return;
      }

      const existingButton = resultNode.querySelector(REVIEW_TRIGGER_SELECTOR);
      if (existingButton) {
        existingButton.dataset.asin = productInfo.asin;
        return;
      }

      const mount = getReviewButtonMount(resultNode);
      if (!mount || !mount.referenceNode) {
        return;
      }

      const wrapper = document.createElement("span");
      wrapper.className = "amazon-delivery-sorter__review-entry";
      if (mount.mode === "block") {
        wrapper.classList.add("amazon-delivery-sorter__review-entry--block");
      }
      wrapper.dataset.amazonDeliverySorterReviewEntry = "true";

      const button = document.createElement("button");
      button.type = "button";
      button.className = "amazon-delivery-sorter__review-trigger";
      button.dataset.amazonDeliverySorterReviewTrigger = "true";
      button.dataset.asin = productInfo.asin;
      button.textContent = "1-star reviews";
      button.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        openReviewsForResult(resultNode);
      });

      wrapper.appendChild(button);

      if (!insertAfter(mount.referenceNode, wrapper) && mount.referenceNode.appendChild) {
        mount.referenceNode.appendChild(wrapper);
      }
    });

    syncReviewButtons();
  }

  function ensureToolbar() {
    if (document.getElementById(TOOLBAR_ID)) {
      syncToolbarControls();
      syncReviewButtons();
      return;
    }

    const toolbar = document.createElement("div");
    toolbar.id = TOOLBAR_ID;
    toolbar.dataset.expanded = "false";
    toolbar.innerHTML =
      '<div id="amazon-delivery-sorter-toolbar-title" class="amazon-delivery-sorter__title">Delivery Sort</div>' +
      '<div class="amazon-delivery-sorter__controls">' +
      '<button id="amazon-delivery-sorter-asc" type="button">Soonest</button>' +
      '<button id="amazon-delivery-sorter-desc" type="button">Latest</button>' +
      '<button id="amazon-delivery-sorter-reset" type="button">Restore</button>' +
      "</div>" +
      '<label class="amazon-delivery-sorter__toggle">' +
      '<input id="amazon-delivery-sorter-auto-sort" type="checkbox" />' +
      "<span>Auto-sort new results</span>" +
      "</label>" +
      '<div id="amazon-delivery-sorter-status" class="amazon-delivery-sorter__status">Ready.</div>' +
      '<div id="amazon-delivery-sorter-review-panel" class="amazon-delivery-sorter__review-panel" hidden>' +
      '<div class="amazon-delivery-sorter__review-header">' +
      '<div class="amazon-delivery-sorter__review-heading">' +
      '<div class="amazon-delivery-sorter__review-eyebrow">1-star reviews</div>' +
      '<div id="amazon-delivery-sorter-review-title" class="amazon-delivery-sorter__review-title">Select a result</div>' +
      "</div>" +
      '<button id="amazon-delivery-sorter-review-close" class="amazon-delivery-sorter__review-close" type="button">Close</button>' +
      "</div>" +
      '<div id="amazon-delivery-sorter-review-meta" class="amazon-delivery-sorter__review-meta"></div>' +
      '<div class="amazon-delivery-sorter__review-links">' +
      '<a id="amazon-delivery-sorter-review-link" class="amazon-delivery-sorter__review-link" href="#" target="_blank" rel="noopener noreferrer" hidden>Open on Amazon</a>' +
      "</div>" +
      '<div id="amazon-delivery-sorter-review-feedback" class="amazon-delivery-sorter__review-feedback" data-state="info">Click a 1-star reviews chip on any result card.</div>' +
      '<div id="amazon-delivery-sorter-review-list" class="amazon-delivery-sorter__review-list"></div>' +
      "</div>";

    document.body.appendChild(toolbar);

    document
      .getElementById("amazon-delivery-sorter-asc")
      .addEventListener("click", function () {
        settings.sortDirection = "asc";
        saveSettings({
          sortDirection: "asc"
        }).then(function () {
          applySort("asc", "manual");
        });
      });

    document
      .getElementById("amazon-delivery-sorter-desc")
      .addEventListener("click", function () {
        settings.sortDirection = "desc";
        saveSettings({
          sortDirection: "desc"
        }).then(function () {
          applySort("desc", "manual");
        });
      });

    document
      .getElementById("amazon-delivery-sorter-reset")
      .addEventListener("click", function () {
        restoreOriginalOrder();
      });

    document
      .getElementById("amazon-delivery-sorter-auto-sort")
      .addEventListener("change", function (event) {
        saveSettings({
          autoSort: event.target.checked
        }).then(function () {
          syncToolbarControls();
          updateToolbarStatus(
            event.target.checked
              ? "Auto-sort enabled for newly loaded search results."
              : "Auto-sort disabled. Use the buttons to sort manually.",
            "info"
          );
          if (event.target.checked) {
            scheduleAutoSort();
          }
        });
      });

    document
      .getElementById("amazon-delivery-sorter-review-close")
      .addEventListener("click", function () {
        clearReviewPanel();
      });

    syncToolbarControls();
    syncReviewButtons();
    syncToolbarMode();
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      "#" +
      TOOLBAR_ID +
      " {" +
      "position: fixed;" +
      "top: 16px;" +
      "right: 16px;" +
      "z-index: 2147483647;" +
      "width: 260px;" +
      "padding: 14px;" +
      "border-radius: 14px;" +
      "background: rgba(17, 24, 39, 0.94);" +
      "color: #f9fafb;" +
      "font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;" +
      "box-shadow: 0 12px 32px rgba(15, 23, 42, 0.28);" +
      "backdrop-filter: blur(10px);" +
      "transition: width 160ms ease, max-height 160ms ease;" +
      "}" +
      "#" +
      TOOLBAR_ID +
      "[data-expanded='true'] {" +
      "width: 380px;" +
      "max-height: calc(100vh - 32px);" +
      "overflow: hidden;" +
      "}" +
      "#" +
      TOOLBAR_ID +
      "[data-page-type='product'] {" +
      "width: 380px;" +
      "max-height: calc(100vh - 32px);" +
      "overflow: hidden;" +
      "}" +
      "#" +
      TOOLBAR_ID +
      " * { box-sizing: border-box; }" +
      "#" +
      TOOLBAR_ID +
      " button {" +
      "border: 0;" +
      "border-radius: 10px;" +
      "padding: 8px 10px;" +
      "background: #e5e7eb;" +
      "color: #111827;" +
      "cursor: pointer;" +
      "font-weight: 600;" +
      "}" +
      "#" +
      TOOLBAR_ID +
      " button[data-active='true'] {" +
      "background: #f59e0b;" +
      "}" +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__title {" +
      "font-size: 14px;" +
      "font-weight: 700;" +
      "margin-bottom: 10px;" +
      "}" +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__controls {" +
      "display: grid;" +
      "grid-template-columns: repeat(3, minmax(0, 1fr));" +
      "gap: 8px;" +
      "margin-bottom: 10px;" +
      "}" +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__toggle {" +
      "display: flex;" +
      "align-items: center;" +
      "gap: 8px;" +
      "margin-bottom: 10px;" +
      "}" +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__status {" +
      "font-size: 12px;" +
      "color: #d1d5db;" +
      "}" +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__status[data-state='success'] { color: #bbf7d0; }" +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__status[data-state='warning'] { color: #fde68a; }" +
      "#" +
      TOOLBAR_ID +
      "[data-page-type='product'] .amazon-delivery-sorter__controls," +
      "#" +
      TOOLBAR_ID +
      "[data-page-type='product'] .amazon-delivery-sorter__toggle," +
      "#" +
      TOOLBAR_ID +
      "[data-page-type='product'] .amazon-delivery-sorter__status," +
      "#" +
      TOOLBAR_ID +
      "[data-page-type='product'] .amazon-delivery-sorter__review-close { display: none; }" +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__review-panel {" +
      "margin-top: 12px;" +
      "padding-top: 12px;" +
      "border-top: 1px solid rgba(148, 163, 184, 0.28);" +
      "}" +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__review-panel[hidden] { display: none !important; }" +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__review-header {" +
      "display: flex;" +
      "justify-content: space-between;" +
      "gap: 12px;" +
      "align-items: flex-start;" +
      "margin-bottom: 8px;" +
      "}" +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__review-heading { min-width: 0; }" +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__review-eyebrow {" +
      "font-size: 11px;" +
      "letter-spacing: 0.04em;" +
      "text-transform: uppercase;" +
      "color: #fbbf24;" +
      "margin-bottom: 4px;" +
      "}" +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__review-title {" +
      "font-size: 13px;" +
      "font-weight: 700;" +
      "color: #f9fafb;" +
      "}" +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__review-meta {" +
      "font-size: 12px;" +
      "color: #cbd5e1;" +
      "margin-bottom: 8px;" +
      "}" +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__review-links {" +
      "margin-bottom: 8px;" +
      "}" +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__review-link {" +
      "color: #fbbf24;" +
      "font-weight: 600;" +
      "text-decoration: none;" +
      "}" +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__review-link:hover {" +
      "text-decoration: underline;" +
      "}" +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__review-close {" +
      "background: transparent;" +
      "color: #cbd5e1;" +
      "padding: 6px 8px;" +
      "border: 1px solid rgba(203, 213, 225, 0.22);" +
      "}" +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__review-feedback {" +
      "font-size: 12px;" +
      "color: #d1d5db;" +
      "margin-bottom: 8px;" +
      "}" +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__review-feedback[data-state='success'] { color: #bbf7d0; }" +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__review-feedback[data-state='warning'] { color: #fde68a; }" +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__review-list {" +
      "display: grid;" +
      "gap: 10px;" +
      "max-height: 48vh;" +
      "overflow-y: auto;" +
      "padding-right: 4px;" +
      "}" +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__review-card {" +
      "padding: 10px;" +
      "border-radius: 12px;" +
      "background: rgba(15, 23, 42, 0.55);" +
      "border: 1px solid rgba(148, 163, 184, 0.18);" +
      "}" +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__review-card-heading {" +
      "display: flex;" +
      "justify-content: space-between;" +
      "gap: 10px;" +
      "margin-bottom: 6px;" +
      "}" +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__review-card-title {" +
      "font-size: 12px;" +
      "font-weight: 700;" +
      "color: #f9fafb;" +
      "}" +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__review-card-rating {" +
      "font-size: 11px;" +
      "font-weight: 700;" +
      "color: #fca5a5;" +
      "white-space: nowrap;" +
      "}" +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__review-card-meta," +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__review-card-helpful {" +
      "font-size: 11px;" +
      "color: #cbd5e1;" +
      "}" +
      "#" +
      TOOLBAR_ID +
      " .amazon-delivery-sorter__review-card-body {" +
      "font-size: 12px;" +
      "color: #e5e7eb;" +
      "margin: 8px 0;" +
      "white-space: normal;" +
      "}" +
      ".amazon-delivery-sorter__review-entry {" +
      "display: inline-flex;" +
      "margin-left: 8px;" +
      "vertical-align: middle;" +
      "}" +
      ".amazon-delivery-sorter__review-entry--block {" +
      "display: block;" +
      "margin: 8px 0 0;" +
      "}" +
      ".amazon-delivery-sorter__review-trigger {" +
      "appearance: none;" +
      "border: 1px solid #f59e0b;" +
      "border-radius: 999px;" +
      "padding: 4px 10px;" +
      "background: rgba(255, 255, 255, 0.92);" +
      "color: #7c2d12;" +
      "cursor: pointer;" +
      "font: 600 12px/1.2 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;" +
      "}" +
      ".amazon-delivery-sorter__review-trigger[data-active='true'] {" +
      "background: #f59e0b;" +
      "color: #111827;" +
      "}" +
      ".amazon-delivery-sorter__review-trigger:hover {" +
      "background: #fef3c7;" +
      "}";

    document.head.appendChild(style);
  }

  function setupObserver() {
    if (observer) {
      observer.disconnect();
    }

    observer = new MutationObserver(function (mutations) {
      if (applyingSort) {
        return;
      }

      const relevantChange = mutations.some(function (mutation) {
        return (
          mutation.type === "childList" &&
          (Array.from(mutation.addedNodes).some(function (node) {
            return node.nodeType === Node.ELEMENT_NODE;
          }) ||
            Array.from(mutation.removedNodes).some(function (node) {
              return node.nodeType === Node.ELEMENT_NODE;
            }))
        );
      });

      if (relevantChange) {
        ensureToolbar();
        if (isSearchPage()) {
          ensureReviewButtons();
          scheduleAutoSort();
        }
        syncToolbarMode();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function getStatus() {
    const productInfo = getProductPageInfo();
    const results = isSearchPage() ? collectResults() : [];
    const knownCount = results.filter(function (entry) {
      return entry.estimate.isKnown;
    }).length;

    return {
      isAmazonSearchPage: isSearchPage(),
      isAmazonProductPage: isProductPage(),
      totalCount: results.length,
      knownCount: knownCount,
      currentOrder: currentOrder,
      autoSort: settings.autoSort,
      sortDirection: settings.sortDirection,
      activeReviewAsin: activeReviewAsin,
      productTitle: productInfo ? productInfo.title : "",
      showProductPageReviews: settings.showProductPageReviews
    };
  }

  function handleMessage(message, sender, sendResponse) {
    if (!message || !message.type) {
      return;
    }

    if (message.type === "AMAZON_DELIVERY_SORTER_GET_STATUS") {
      sendResponse(getStatus());
      return;
    }

    if (message.type === "AMAZON_DELIVERY_SORTER_SORT_NOW") {
      const direction = message.direction === "desc" ? "desc" : "asc";
      settings.sortDirection = direction;
      applySort(direction, "manual");
      sendResponse(getStatus());
      return;
    }

    if (message.type === "AMAZON_DELIVERY_SORTER_RESTORE") {
      restoreOriginalOrder();
      sendResponse(getStatus());
      return;
    }
  }

  function watchStorage() {
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName !== "sync") {
        return;
      }

      if (changes.autoSort) {
        settings.autoSort = changes.autoSort.newValue;
      }

      if (changes.sortDirection) {
        settings.sortDirection = changes.sortDirection.newValue;
      }

      if (changes.showProductPageReviews) {
        settings.showProductPageReviews = changes.showProductPageReviews.newValue;
      }

      syncToolbarControls();
      syncToolbarMode();

      if (settings.autoSort && isSearchPage()) {
        scheduleAutoSort();
      }
    });
  }

  function init() {
    if (!isSupportedPage()) {
      return;
    }

    loadSettings().then(function () {
      ensureStyles();
      ensureToolbar();
      if (isSearchPage()) {
        ensureReviewButtons();
      }
      setupObserver();
      watchStorage();
      chrome.runtime.onMessage.addListener(handleMessage);
      syncToolbarMode();

      if (settings.autoSort) {
        if (isSearchPage()) {
          scheduleAutoSort();
        }
      } else if (isSearchPage()) {
        updateToolbarStatus("Auto-sort is off. Use the buttons to sort the loaded results.", "info");
      }
    });
  }

  init();
})();
