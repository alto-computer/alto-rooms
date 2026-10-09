// A content script for the e2e tests: proves it ran inside the document without touching its body.
document.documentElement.dataset.marker = "1";
parent.postMessage({ rooms: "content", plugin: "marker", type: "ready" }, "*");
