.PHONY: dev build frontend test e2e run migrate doctor clean

frontend:
	cd web && npm ci && npm run build

build: frontend
	CGO_ENABLED=0 go build -trimpath -o watchtogether ./cmd/watchtogether

test:
	go test ./...
	cd web && npm test
	cd web && npm run build
	go build ./cmd/watchtogether

e2e:
	docker compose up -d minio minio-init
	docker compose wait minio-init
	cd web && npm run e2e

dev:
	go run ./cmd/watchtogether serve

run: build
	./watchtogether serve

migrate:
	go run ./cmd/watchtogether migrate

doctor:
	go run ./cmd/watchtogether doctor

clean:
	go clean
	cd web && npm run build -- --emptyOutDir
