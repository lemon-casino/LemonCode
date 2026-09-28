const PREAPPROVED_HOSTS = new Set([
  "modelcontextprotocol.io",
  "agentskills.io",
  "docs.python.org",
  "en.cppreference.com",
  "docs.oracle.com",
  "learn.microsoft.com",
  "developer.mozilla.org",
  "go.dev",
  "pkg.go.dev",
  "www.php.net",
  "docs.swift.org",
  "kotlinlang.org",
  "ruby-doc.org",
  "doc.rust-lang.org",
  "www.typescriptlang.org",
  "react.dev",
  "angular.io",
  "vuejs.org",
  "nextjs.org",
  "expressjs.com",
  "nodejs.org",
  "bun.sh",
  "jquery.com",
  "getbootstrap.com",
  "tailwindcss.com",
  "d3js.org",
  "threejs.org",
  "redux.js.org",
  "webpack.js.org",
  "jestjs.io",
  "reactrouter.com",
  "docs.djangoproject.com",
  "flask.palletsprojects.com",
  "fastapi.tiangolo.com",
  "pandas.pydata.org",
  "numpy.org",
  "www.tensorflow.org",
  "pytorch.org",
  "scikit-learn.org",
  "matplotlib.org",
  "requests.readthedocs.io",
  "jupyter.org",
  "laravel.com",
  "symfony.com",
  "docs.spring.io",
  "hibernate.org",
  "tomcat.apache.org",
  "gradle.org",
  "maven.apache.org",
  "asp.net",
  "dotnet.microsoft.com",
  "blazor.net",
  "reactnative.dev",
  "docs.flutter.dev",
  "developer.apple.com",
  "developer.android.com",
  "keras.io",
  "spark.apache.org",
  "www.mongodb.com",
  "redis.io",
  "www.postgresql.org",
  "dev.mysql.com",
  "www.sqlite.org",
  "graphql.org",
  "prisma.io",
  "docs.getdbt.com",
  "docs.aws.amazon.com",
  "cloud.google.com",
  "kubernetes.io",
  "www.docker.com",
  "www.terraform.io",
  "www.ansible.com",
  "docs.stripe.com",
  "docs.netlify.com",
  "devcenter.heroku.com",
  "cypress.io",
  "selenium.dev",
  "docs.unity.com",
  "docs.unrealengine.com",
  "git-scm.com",
  "nginx.org",
  "httpd.apache.org",
]);

const PREAPPROVED_PATH_PREFIXES = new Map([
  ["wordpress.org", ["/documentation"]],
  ["huggingface.co", ["/docs"]],
  ["www.kaggle.com", ["/docs"]],
  ["vercel.com", ["/docs"]],
]);

export function isWebFetchPreapprovedUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (PREAPPROVED_HOSTS.has(url.hostname)) {
    return true;
  }

  const prefixes = PREAPPROVED_PATH_PREFIXES.get(url.hostname);
  if (!prefixes) {
    return false;
  }
  if (/%(25)*(2f|5c|2e)/iu.test(url.pathname)) {
    return false;
  }
  return prefixes.some(
    (prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
  );
}
