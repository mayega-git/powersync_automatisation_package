package io.taskly.jpa.notify;

import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/** Talks to the transactional mail provider: an effect no device may reproduce. */
@Component
public class MailNotifier {

    private final RestClient client;

    public MailNotifier(RestClient.Builder builder) {
        this.client = builder.baseUrl("https://mail.example.test").build();
    }

    public String shareBoard(UUID boardId, String recipient) {
        return client.post()
                .uri("/send")
                .body(Map.of("board", boardId.toString(), "to", recipient))
                .retrieve()
                .body(String.class);
    }
}
