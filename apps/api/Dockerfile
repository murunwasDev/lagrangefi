FROM gradle:8.8-jdk17 AS builder
WORKDIR /app
COPY build.gradle.kts settings.gradle.kts gradle.properties ./
RUN gradle dependencies --no-daemon
COPY src ./src
RUN gradle installDist --no-daemon

FROM eclipse-temurin:17-jre-alpine AS runner
WORKDIR /app
COPY --from=builder /app/build/install/lagrangefi-api ./
EXPOSE 3000
CMD ["./bin/lagrangefi-api"]
