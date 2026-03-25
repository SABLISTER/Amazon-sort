"use strict";

const DEFAULT_SETTINGS = {
  autoSort: true,
  sortDirection: "asc",
  showProductPageReviews: false
};

function getStorage(values) {
  return new Promise(function (resolve) {
    chrome.storage.sync.get(values, resolve);
  });
}

function setStorage(values) {
  return new Promise(function (resolve) {
    chrome.storage.sync.set(values, resolve);
  });
}

function getActiveTab() {
  return new Promise(function (resolve) {
    chrome.tabs.query(
      {
        active: true,
        currentWindow: true
      },
      function (tabs) {
        resolve((tabs && tabs[0]) || null);
      }
    );
  });
}

function sendToActiveTab(message) {
  return getActiveTab().then(function (tab) {
    if (!tab || typeof tab.id !== "number") {
      return null;
    }

    return new Promise(function (resolve) {
      chrome.tabs.sendMessage(tab.id, message, function (response) {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }

        resolve(response || null);
      });
    });
  });
}

function setStatus(message) {
  const status = document.getElementById("status");
  status.textContent = message;
}

function syncForm(settings) {
  document.getElementById("autoSort").checked = Boolean(settings.autoSort);
  document.getElementById("sortDirection").value = settings.sortDirection === "desc" ? "desc" : "asc";
  document.getElementById("showProductPageReviews").checked = Boolean(
    settings.showProductPageReviews
  );
}

function describePageStatus(status) {
  if (!status || (!status.isAmazonSearchPage && !status.isAmazonProductPage)) {
    return "Open an Amazon.com search results page or product page to use the extension.";
  }

  if (status.isAmazonProductPage) {
    const title = status.productTitle ? '"' + status.productTitle + '"' : "This product";
    return (
      title +
      " is open. Product-page 1-star panel: " +
      (status.showProductPageReviews ? "on" : "off") +
      "."
    );
  }

  if (!status.totalCount) {
    return "The page is open, but no sortable search results are loaded yet.";
  }

  return (
    "Loaded results: " +
    status.totalCount +
    ". Known delivery estimates: " +
    status.knownCount +
    ". Current order: " +
    status.currentOrder +
    "."
  );
}

function refreshPageStatus() {
  return sendToActiveTab({
    type: "AMAZON_DELIVERY_SORTER_GET_STATUS"
  }).then(function (status) {
    setStatus(describePageStatus(status));
    return status;
  });
}

async function init() {
  const settings = Object.assign({}, DEFAULT_SETTINGS, await getStorage(DEFAULT_SETTINGS));
  syncForm(settings);
  await refreshPageStatus();

  document.getElementById("autoSort").addEventListener("change", async function (event) {
    await setStorage({
      autoSort: event.target.checked
    });
    await refreshPageStatus();
  });

  document.getElementById("sortDirection").addEventListener("change", async function (event) {
    await setStorage({
      sortDirection: event.target.value
    });
    await refreshPageStatus();
  });

  document
    .getElementById("showProductPageReviews")
    .addEventListener("change", async function (event) {
      await setStorage({
        showProductPageReviews: event.target.checked
      });
      await refreshPageStatus();
    });

  document.getElementById("sortNow").addEventListener("click", async function () {
    const direction = document.getElementById("sortDirection").value;
    await setStorage({
      sortDirection: direction
    });
    const status = await sendToActiveTab({
      type: "AMAZON_DELIVERY_SORTER_SORT_NOW",
      direction: direction
    });
    setStatus(describePageStatus(status));
  });

  document.getElementById("restoreOrder").addEventListener("click", async function () {
    const status = await sendToActiveTab({
      type: "AMAZON_DELIVERY_SORTER_RESTORE"
    });
    setStatus(describePageStatus(status));
  });
}

init();
