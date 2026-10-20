import { Visit } from './visit.schema';
import { CheckOutDto } from './dto/visit.dto';
export class VisitService {
  checkOut(dto: CheckOutDto) {
    const visit = new Visit();
    visit.outcome = dto.outcome;
    return visit;
  }
  list() { return []; }
}
