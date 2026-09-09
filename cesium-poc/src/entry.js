if (new URLSearchParams(location.search).get("demo") === "i595") {
  import("./i595Demo.js");
} else {
  import("./main.js");
}
