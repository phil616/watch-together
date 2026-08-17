FROM node:24-alpine AS web-build
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.26-alpine AS go-build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web-build /src/internal/webui/dist ./internal/webui/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /watchtogether ./cmd/watchtogether

FROM alpine:3.23
RUN apk add --no-cache ca-certificates tzdata && addgroup -S app && adduser -S -G app app
WORKDIR /app
COPY --from=go-build /watchtogether /usr/local/bin/watchtogether
RUN mkdir /data && chown app:app /data
USER app
VOLUME ["/data"]
EXPOSE 8080
ENV APP_ENV=production HTTP_LISTEN_ADDR=0.0.0.0:8080 DATABASE_PATH=/data/application.db
ENTRYPOINT ["watchtogether"]
CMD ["serve"]

