# syntax=docker/dockerfile:1.4
# Build stage
FROM node:18 as build
WORKDIR /src
COPY . ./

RUN corepack enable && corepack prepare yarn@3.6.3 --activate && corepack prepare yarn@3.6.3 --activate && corepack prepare yarn@3.6.3 --activate
RUN yarn install

RUN yarn run web:build:prod

# Release stage
FROM node:18-alpine
WORKDIR /app

ENV LAYOUTS_DIR=/foxglove/layouts
ENV DATA_DIR=/foxglove/data

COPY --from=build /src/web/.webpack ./public
COPY --from=build /src/node_modules ./node_modules
COPY web/server.mjs ./server.mjs
COPY web/wsBridge.mjs ./wsBridge.mjs

VOLUME ["/foxglove/layouts"]
VOLUME ["/foxglove/data"]

EXPOSE 8080

COPY <<EOF /entrypoint.sh
# Optionally override the default layout with one provided via bind mount
mkdir -p /foxglove/layouts
touch /foxglove/default-layout.json
index_html=\$(cat public/index.html)
replace_pattern='/*FOXGLOVE_STUDIO_DEFAULT_LAYOUT_PLACEHOLDER*/'
replace_value=\$(cat /foxglove/default-layout.json)
echo "\${index_html/"\$replace_pattern"/\$replace_value}" > public/index.html

# Continue executing the CMD
exec "\$@"
EOF

ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
CMD ["node", "server.mjs"]
