# Example - Domains to IPs

This directory contains a JavaScript-based integration example. The integration offers an editable list of domain names whose resolved IPv4 addresses are then used as assets.

The aim is to demonstrate most of the integrations API functionality and development flow:

- Using the API emulator and Docker Compose for development

- Interacting with Badrap integrations API

  - Fetching & updating instance state
  - Authenticating requests to and from the Badrap integrations API

- UI coding

  - Outputting UI structures as JSON
  - Reacting to UI actions
  - Serving custom resources (i.e. images)

- Updating assets in a background polling loop

Start reading the code from [`src/index.js`](src/index.js).

## Launching the Development Environment

Launch the development server that will restart on each code change. Docker Compose will also launch the API emulator that acts as a frontend to the JavaScript service.

```sh
$ docker-compose up
```

If everything went well, open the API emulator frontend by directing your browser to http://localhost:4004.
