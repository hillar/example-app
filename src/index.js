const { URL } = require("url");
const path = require("path");
const dns = require("dns");
const express = require("express");
const morgan = require("morgan");
const router = require("express-promise-router");
const fetch = require("node-fetch");
const htm = require("htm");

// Read the configuration from environment variables.
const [
  SERVER_URL, // Badrap's base URL (e.g. "https://staging.badrap.io/")
  INTEGRATION_TOKEN // The token used to authenticate to SERVER_URL
] = ["SERVER_URL", "INTEGRATION_TOKEN"].map(key => {
  if (!process.env[key]) {
    console.error(`ERROR: environment variable ${key} not set`);
    process.exit(2);
  }
  return process.env[key];
});

async function request(url, options = {}) {
  const realUrl = new URL(url, SERVER_URL).toString();

  // Deliver the token in the Authorization header.
  const headers = {
    Authorization: `Bearer ${INTEGRATION_TOKEN}`,
    ...options.headers
  };

  const response = await fetch(realUrl, { ...options, headers });
  if (!response.ok) {
    throw new HttpError(response.status, response.statusText);
  }
  return response;
}

// A special error class for HTTP errors.
class HttpError extends Error {
  constructor(status, statusText) {
    super(`HTTP status ${status}: ${statusText}`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.status = status;
    this.statusText = statusText;
  }
}

// Go through the instance list once. Update the assets for each instance.
async function pollOnce() {
  // Get the list of instance list.
  const instances = await request("/api/integration/instances", {
    method: "GET"
  }).then(r => r.json());

  for (const { id, removed } of instances) {
    // Clean up instances of removed users (etc.)
    if (removed) {
      await request("/api/integration/instances/" + id, {
        method: "DELETE"
      });
      continue;
    }

    // Get the instance's current state.
    const { state } = await request("/api/integration/instances/" + id, {
      method: "GET"
    }).then(r => r.json());

    const assets = [];
    for (const domain of state.domains || []) {
      const ips = await new Promise(resolve => {
        dns.resolve4(domain, (_, ips) => resolve(ips || []));
      });
      for (const ip of ips) {
        assets.push({
          type: "ip",
          ip: ip,
          key: domain,
          data: {
            location: domain
          }
        });
      }
    }

    // Send the new list of assets for this instance.
    // Let's also ignore potential concurrently happened state changes
    // with If-Match: *, as we only update the assets.
    await request("/api/integration/instances/" + id, {
      method: "PATCH",
      headers: {
        "If-Match": "*",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ assets })
    });
  }
}

// Update the assets for all instances continuously,
// rechecking them every 10 seconds.
async function poll() {
  for (;;) {
    try {
      await pollOnce();
    } catch (err) {
      if (err instanceof fetch.FetchError || err instanceof HttpError) {
        console.log(err);
      } else {
        throw err;
      }
    }
    await new Promise(resolve => setTimeout(() => resolve(), 10000));
  }
}
poll().then(
  () => {
    process.exit();
  },
  err => {
    console.error(err);
    process.exit(1);
  }
);

const api = router();

// Check that the requests are sent by the server.
api.use(async (req, res) => {
  const auth = req.headers.authorization || "";
  const match = auth.match(/^Bearer\s+([a-z0-9-._~+/]+=*)$/i);
  if (!match) {
    return res.sendStatus(401);
  }
  res.locals.token = await request("/api/integration/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      token: match[1]
    })
  }).then(r => r.json());
  return "next";
});

async function getState(instanceId) {
  const { state } = await request("/api/integration/instances/" + instanceId, {
    method: "GET"
  }).then(r => r.json());
  return state;
}

async function setState(instanceId, callback) {
  for (;;) {
    // Read the current state. Remember the ETag.
    const response = await request("/api/integration/instances/" + instanceId, {
      method: "GET"
    });
    const etag = response.headers.get("etag");
    const { state } = await response.json();

    const newState = await callback(state);

    // Skip updating if the new state is falsy (undefined etc.)
    if (!newState) {
      return state;
    }

    try {
      // Store the updated state. Use the previous ETag to ensure
      // that the state hasn't changed since we read it.
      // HTTP error code 412 means that the state has changed and we should
      // retry.
      await request("/api/integration/instances/" + instanceId, {
        method: "PATCH",
        headers: {
          "If-Match": etag,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ state: newState })
      });
    } catch (err) {
      if (err instanceof HttpError && err.status === 412) {
        continue;
      }
      throw err;
    }
    return newState;
  }
}

const ui = htm.bind((type, props, ...children) => {
  if (typeof type === "string") {
    return {
      type,
      props: props || undefined,
      children: children.length > 0 ? children : undefined
    };
  }
  return type(props, children);
});

function DomainList({ domains = [] }) {
  if (domains.length === 0) {
    return ui`
      <Box class="flex justify-between items-center py-2">
        No domains yet.
      </Box>
    `;
  }

  return domains.map(
    domain =>
      ui`
        <Box class="flex justify-between items-center py-2">
          ${domain}
          <Button action=${{ type: "delete", domain }} variant="danger">
            Delete
          </Button>
        </Box>
      `
  );
}

api.post("/ui", express.json(), async (req, res) => {
  const { action = {}, clientState = {} } = req.body.payload;
  const { instanceId } = res.locals.token;

  if (action.type === "add") {
    await setState(instanceId, state => {
      const domain = clientState.domain;
      if (!domain) {
        return;
      }
      state.domains = state.domains || [];
      if (!state.domains.includes(domain)) {
        state.domains.push(domain);
        return state;
      }
    });
  } else if (action.type === "delete") {
    await setState(instanceId, state => {
      if (!state.domains) {
        return;
      }
      const index = state.domains.indexOf(action.domain);
      if (index < 0) {
        return;
      }
      state.domains.splice(index, 1);
      return state;
    });
  }

  const state = await getState(instanceId);
  res.json(ui`
    <Box class="flex justify-center">
      <Box class="w-2/5 w-3">
        <Image src="static/logo.png" />
      </Box>
    </Box>
    <${DomainList} domains=${state.domains} />
    <Form>
      <TextField required name="domain" />
      <Button submit variant="primary" action=${{ type: "add" }}>
        Add a domain
      </Button>
    </Form>
  `);
});

api.use("/static", express.static(path.resolve(__dirname, "../static")));

const app = express();
app.use(morgan("dev"));
app.use("/api", api);
const server = app.listen(process.env.PORT || 4005, () => {
  const addr = server.address();
  console.log("Listening on port %s...", addr.port);
});