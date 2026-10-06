package io.taskly.api.label;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

@RestController
@RequestMapping("/api/labels")
public class LabelController {

    private final LabelRepository labels;

    public LabelController(LabelRepository labels) {
        this.labels = labels;
    }

    @GetMapping
    public Flux<Label> all() {
        return labels.findAllByOrderByRankAsc();
    }
}
