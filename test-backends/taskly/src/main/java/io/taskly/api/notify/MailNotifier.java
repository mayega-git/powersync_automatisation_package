package io.taskly.api.notify;

import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

/** Talks to the transactional mail provider. */
@Component
public class MailNotifier {

    private final WebClient client;

    public MailNotifier(WebClient.Builder builder) {
        this.client = builder.baseUrl("https://mail.example.test").build();
    }

    public Mono<String> shareBoard(UUID boardId, String recipient) {
        return client.post()
                .uri("/send")
                .bodyValue(Map.of("board", boardId.toString(), "to", recipient))
                .exchangeToMono(response -> response.bodyToMono(String.class));
    }
}
